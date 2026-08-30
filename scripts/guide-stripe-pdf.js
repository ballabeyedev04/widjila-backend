'use strict';

/**
 * Génère le guide PDF « Obtenir ses clés Stripe — France ».
 *
 * Le document explique comment obtenir chacune des variables attendues par
 * `.env` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
 * `STRIPE_WEBHOOK_SECRET`) et comment activer un compte Stripe français
 * relié à un compte bancaire ouvert en France.
 *
 * ── Sources ──────────────────────────────────────────────────────────────
 * Le contenu est tiré de la documentation Stripe consultée le 30/08/2026 :
 * docs.stripe.com/keys, /webhooks, /acceptable-verification-documents,
 * /get-started/account/activate, /api/errors. Les URL exactes figurent en
 * dernière page du PDF.
 *
 * Rien n'est inventé : lorsqu'une information n'a pas pu être vérifiée
 * (notamment la liste française exacte des justificatifs, que Stripe rend
 * dynamiquement derrière un sélecteur de pays), le document le dit et
 * renvoie à la page officielle plutôt que de proposer une liste plausible.
 *
 * Usage :
 *   node scripts/guide-stripe-pdf.js [chemin/de/sortie.pdf]
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Palette de l'application — le guide appartient au projet, il en porte les
// couleurs plutôt qu'un thème générique.
const ORANGE = '#f2600c';
const ENCRE = '#1b1f24';
const GRIS = '#5b6672';
const GRIS_CLAIR = '#e4e8ec';
const FOND_BLOC = '#f6f8fa';
const ROUGE = '#c0392b';
const VERT = '#1e7a4b';

const MARGE = 54;
const LARGEUR = 595.28 - MARGE * 2; // A4 portrait

const sortie = process.argv[2]
  || path.join(__dirname, '..', 'docs', 'Guide_Stripe_Widjila.pdf');

fs.mkdirSync(path.dirname(sortie), { recursive: true });

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: MARGE, bottom: MARGE + 24, left: MARGE, right: MARGE },
  bufferPages: true, // requis pour numéroter « page X / Y » à la fin
  info: {
    Title: 'Guide Stripe — Obtenir ses clés et activer son compte (France)',
    Author: 'Widjila — Suivi de chantier',
    Subject: 'Configuration des paiements Stripe pour un compte bancaire français',
  },
});

doc.pipe(fs.createWriteStream(sortie));

// ═══════════════════════════════════════════════════════════════════════════
//  Briques de mise en page
// ═══════════════════════════════════════════════════════════════════════════

/** Réserve la place d'un bloc : évite qu'un titre finisse seul en bas de page. */
function place(hauteur) {
  if (doc.y + hauteur > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function titre1(texte, numero) {
  place(80);
  doc.moveDown(0.8);
  const y = doc.y;
  doc.rect(MARGE, y, 4, 22).fill(ORANGE);
  doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(16)
    .text(numero ? `${numero}. ${texte}` : texte, MARGE + 14, y + 2, { width: LARGEUR - 14 });
  doc.moveDown(0.5);
}

function titre2(texte) {
  place(50);
  doc.moveDown(0.5);
  doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(11.5)
    .text(texte, MARGE, doc.y, { width: LARGEUR });
  doc.moveDown(0.3);
}

function para(texte, options = {}) {
  doc.fillColor(options.couleur || GRIS).font(options.gras ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(options.taille || 10)
    .text(texte, MARGE, doc.y, { width: LARGEUR, align: 'justify', lineGap: 2.2 });
  doc.moveDown(0.45);
}

/** Liste à puces ; `etapes: true` numérote au lieu de pucer. */
function liste(elements, { etapes = false } = {}) {
  elements.forEach((element, i) => {
    const marque = etapes ? `${i + 1}.` : '•';
    place(28);
    const y = doc.y;
    doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(10)
      .text(marque, MARGE + 4, y, { width: 16 });
    doc.fillColor(GRIS).font('Helvetica').fontSize(10)
      .text(element, MARGE + 24, y, { width: LARGEUR - 24, lineGap: 2 });
    doc.moveDown(0.28);
  });
  doc.moveDown(0.25);
}

/** Bloc de code / valeur littérale, sur fond gris. */
function code(lignes) {
  const contenu = Array.isArray(lignes) ? lignes : [lignes];
  doc.font('Courier').fontSize(9);
  const hauteur = contenu.length * 13 + 16;
  place(hauteur + 10);
  const y = doc.y;
  doc.roundedRect(MARGE, y, LARGEUR, hauteur, 4).fill(FOND_BLOC);
  contenu.forEach((ligne, i) => {
    doc.fillColor(ENCRE).font('Courier').fontSize(9)
      .text(ligne, MARGE + 10, y + 8 + i * 13, { width: LARGEUR - 20, lineBreak: false });
  });
  doc.y = y + hauteur + 8;
}

/** Encadré d'avertissement ou d'information. */
function encadre(titreBloc, texte, ton = 'info') {
  const couleur = ton === 'danger' ? ROUGE : ton === 'succes' ? VERT : ORANGE;
  doc.font('Helvetica').fontSize(9.5);
  const hauteurTexte = doc.heightOfString(texte, { width: LARGEUR - 34, lineGap: 1.8 });
  const hauteur = hauteurTexte + 34;
  place(hauteur + 10);
  const y = doc.y;
  doc.roundedRect(MARGE, y, LARGEUR, hauteur, 5).fill(FOND_BLOC);
  doc.rect(MARGE, y, 3.5, hauteur).fill(couleur);
  doc.fillColor(couleur).font('Helvetica-Bold').fontSize(9.5)
    .text(titreBloc, MARGE + 14, y + 9, { width: LARGEUR - 28 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(9.5)
    .text(texte, MARGE + 14, y + 22, { width: LARGEUR - 34, lineGap: 1.8 });
  doc.y = y + hauteur + 10;
}

/** Tableau à deux colonnes. */
function tableau(entetes, lignes, largeurs) {
  const [l1, l2] = largeurs;
  place(60);

  let y = doc.y;
  doc.rect(MARGE, y, LARGEUR, 22).fill(ENCRE);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  doc.text(entetes[0], MARGE + 8, y + 7, { width: l1 - 16 });
  doc.text(entetes[1], MARGE + l1 + 8, y + 7, { width: l2 - 16 });
  y += 22;

  lignes.forEach((ligne, i) => {
    doc.font('Helvetica').fontSize(9);
    const h1 = doc.heightOfString(ligne[0], { width: l1 - 16, lineGap: 1.5 });
    const h2 = doc.heightOfString(ligne[1], { width: l2 - 16, lineGap: 1.5 });
    const hauteur = Math.max(h1, h2) + 14;

    // Report de tableau : la ligne ne doit pas être coupée entre deux pages.
    if (y + hauteur > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
      doc.rect(MARGE, y, LARGEUR, 22).fill(ENCRE);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text(entetes[0], MARGE + 8, y + 7, { width: l1 - 16 });
      doc.text(entetes[1], MARGE + l1 + 8, y + 7, { width: l2 - 16 });
      y += 22;
    }

    if (i % 2 === 0) doc.rect(MARGE, y, LARGEUR, hauteur).fill(FOND_BLOC);
    doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(9)
      .text(ligne[0], MARGE + 8, y + 7, { width: l1 - 16, lineGap: 1.5 });
    doc.fillColor(GRIS).font('Helvetica').fontSize(9)
      .text(ligne[1], MARGE + l1 + 8, y + 7, { width: l2 - 16, lineGap: 1.5 });

    doc.strokeColor(GRIS_CLAIR).lineWidth(0.5)
      .moveTo(MARGE, y + hauteur).lineTo(MARGE + LARGEUR, y + hauteur).stroke();
    y += hauteur;
  });

  doc.y = y + 12;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PAGE DE GARDE
// ═══════════════════════════════════════════════════════════════════════════

doc.rect(0, 0, doc.page.width, 210).fill(ORANGE);
doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30)
  .text('Guide Stripe', MARGE, 62, { width: LARGEUR });
doc.font('Helvetica').fontSize(15)
  .text('Obtenir ses clés et activer son compte', MARGE, 100, { width: LARGEUR });
doc.font('Helvetica-Bold').fontSize(15)
  .text('avec un compte bancaire français', MARGE, 122, { width: LARGEUR });
doc.font('Helvetica').fontSize(10)
  .text('Widjila — Suivi de chantier', MARGE, 160, { width: LARGEUR });

doc.y = 245;
para(
  'Ce document explique, étape par étape, comment obtenir les trois valeurs que '
  + 'l’application attend dans son fichier de configuration, et comment activer un '
  + 'compte Stripe rattaché à un compte bancaire ouvert en France afin de recevoir '
  + 'réellement les paiements.',
  { taille: 11 }
);

titre2('Les valeurs à obtenir');
tableau(
  ['Variable', 'Ce que c’est'],
  [
    ['STRIPE_PUBLISHABLE_KEY', 'Clé publique (pk_…). Utilisée par le navigateur pour afficher le formulaire de carte. Peut être vue de tous, sans danger.'],
    ['STRIPE_SECRET_KEY', 'Clé serveur (sk_… ou rk_…). Elle autorise à encaisser et à rembourser. Elle ne doit JAMAIS quitter le serveur.'],
    ['STRIPE_WEBHOOK_SECRET', 'Secret de signature (whsec_…). Il prouve qu’un message reçu vient bien de Stripe. C’est lui qui empêche un faux « paiement réussi ».'],
  ],
  [170, LARGEUR - 170]
);

encadre(
  'Les variables STRIPE_PRICE_* ne servent pas à cette application',
  'Le fichier .env.example contient encore STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO et '
  + 'STRIPE_PRICE_BUSINESS. Ces variables ne sont plus lues par le code : les tarifs de '
  + 'Widjila vivent dans la base de données et se modifient depuis Admin → « Prix '
  + 'abonnements ». Vous n’avez donc AUCUN produit ni tarif à créer dans Stripe. '
  + 'Laissez ces trois lignes vides ou supprimez-les.',
  'info'
);

doc.fontSize(8.5).fillColor(GRIS).font('Helvetica')
  .text(
    'Document établi le 30 août 2026 à partir de la documentation officielle Stripe. '
    + 'Les interfaces de Stripe évoluent : si un écran diffère, la page officielle citée en fin de document fait foi.',
    MARGE, doc.page.height - MARGE - 60, { width: LARGEUR, align: 'center' }
  );

// ═══════════════════════════════════════════════════════════════════════════
//  1. CE QU'IL FAUT AVOIR SOUS LA MAIN
// ═══════════════════════════════════════════════════════════════════════════

doc.addPage();
titre1('Ce qu’il faut réunir avant de commencer', 1);

para(
  'Stripe est un établissement financier : il est légalement tenu de vérifier qui vous '
  + 'êtes avant de vous verser de l’argent (obligations dites « KYC », Know Your Customer). '
  + 'Réunir ces éléments à l’avance évite de rester bloqué en cours de route.'
);

titre2('Pour l’entreprise');
liste([
  'La dénomination sociale EXACTE, telle qu’elle est enregistrée — elle devra correspondre au caractère près à celle du justificatif que vous téléverserez.',
  'Le numéro SIREN (9 chiffres) qui identifie l’entreprise, et le SIRET (14 chiffres) qui identifie l’établissement. Le SIREN identifie la société entière ; le SIRET désigne le lieu précis où s’exerce l’activité.',
  'Le numéro de TVA intracommunautaire, s’il existe.',
  'L’adresse du siège social, un téléphone et une adresse e-mail de contact.',
  'L’adresse du site web de l’activité.',
]);

titre2('Pour le représentant légal');
liste([
  'Une pièce d’identité en cours de validité (le document exact demandé s’affiche dans le Dashboard).',
  'La date de naissance et l’adresse personnelle, qui devront correspondre à ce que vous saisissez dans Stripe.',
  'Les noms et fonctions des bénéficiaires effectifs, si la société en compte.',
]);

titre2('Pour le compte bancaire français');
liste([
  'L’IBAN du compte qui recevra les virements (format FR76 …). Le compte doit être au nom de l’entité déclarée dans Stripe.',
  'Un RIB ou un relevé de compte, au cas où Stripe demanderait à vérifier que vous êtes bien le titulaire.',
]);

encadre(
  'Le nom doit correspondre exactement',
  'C’est la première cause de rejet. Le nom sur la pièce d’identité, le nom du titulaire du '
  + 'compte bancaire et le nom saisi dans les paramètres Stripe doivent être identiques. Un '
  + 'nom d’usage, une abréviation ou un nom commercial différent de la raison sociale suffit '
  + 'à faire échouer la vérification.',
  'danger'
);

// ═══════════════════════════════════════════════════════════════════════════
//  2. CRÉER LE COMPTE
// ═══════════════════════════════════════════════════════════════════════════

titre1('Créer le compte Stripe', 2);

liste([
  'Ouvrez https://dashboard.stripe.com/register et créez le compte avec une adresse e-mail professionnelle.',
  'Choisissez la France comme pays de l’entreprise.',
  'Activez l’authentification à deux facteurs. Stripe recommande une clé de sécurité ou une passkey plutôt qu’un SMS, le SMS restant vulnérable au détournement de carte SIM.',
], { etapes: true });

encadre(
  'Le pays ne se change plus après activation',
  'Une fois un service Stripe activé en mode réel, le pays d’origine de l’entreprise ne peut '
  + 'plus être modifié : il faudrait créer un nouveau compte. Vérifiez donc ce choix avant de '
  + 'poursuivre.',
  'danger'
);

para(
  'Dès la création, vous disposez d’un environnement de TEST (« sandbox ») entièrement '
  + 'fonctionnel. Vous pouvez y développer et y tester le paiement sans avoir encore activé '
  + 'le compte : aucune carte n’y est réellement débitée.'
);

// ═══════════════════════════════════════════════════════════════════════════
//  3. ACTIVER LE COMPTE
// ═══════════════════════════════════════════════════════════════════════════

titre1('Activer le compte pour encaisser réellement', 3);

para(
  'Tant que le compte n’est pas activé, vous ne pouvez utiliser que les clés de test. '
  + 'L’activation se fait depuis https://dashboard.stripe.com/account/onboarding.'
);

titre2('Informations vues par vos clients');
para(
  'Ces éléments apparaissent sur les relevés bancaires et les reçus. Ils se modifient à tout '
  + 'moment dans Paramètres → Informations publiques.'
);
liste([
  'Nom commercial et adresse du site web.',
  'E-mail, téléphone et adresse du support.',
  'Le « libellé de relevé bancaire » : le texte que votre client verra sur son relevé. S’il ne le reconnaît pas, il conteste le paiement — choisissez un libellé qui évoque clairement votre entreprise.',
]);

titre2('Justificatifs demandés');
para(
  'Stripe indique lui-même, dans Paramètres → Entreprise → État du compte, quel document il '
  + 'attend. Les catégories possibles sont : pièce d’identité, justificatif de domicile, '
  + 'document d’entreprise, document bancaire, statut d’organisation à but non lucratif, et '
  + 'preuve du lien avec l’entreprise.'
);

encadre(
  'La liste française exacte n’est pas reproduite ici — volontairement',
  'Stripe publie la liste des justificatifs acceptés pays par pays, derrière un sélecteur. '
  + 'Cette liste change et je ne peux pas la certifier au moment où ce guide est écrit. '
  + 'Consultez-la directement, France sélectionnée, à l’adresse citée en fin de document, et '
  + 'surtout : le Dashboard vous dit précisément quel document il réclame pour VOTRE compte. '
  + 'Suivez-le plutôt qu’une liste générique.',
  'info'
);

titre2('Règles de format — elles expliquent la plupart des rejets');
liste([
  'Un scan doit être un PDF. La photo d’un document physique doit être un JPEG ou un PNG original, non retouché.',
  'Les captures d’écran sont refusées.',
  'Les photos et scans doivent être en couleur. Une pièce d’identité en noir et blanc est refusée.',
  'Le document ne doit pas être expiré, ni rogné : toutes les bordures doivent être visibles, aucune page ne doit manquer.',
  'Si le verso porte des informations, il doit être fourni également.',
  'Un même document ne peut pas servir à deux exigences : identité et domicile demandent deux documents différents.',
  'Si le pays de résidence de la personne diffère du pays du compte, seul le passeport est accepté pour l’identité.',
]);

para(
  'Le téléversement se fait uniquement depuis le Dashboard : Paramètres → Entreprise → État '
  + 'du compte. N’envoyez jamais ces documents par e-mail. Stripe indique que l’examen peut '
  + 'prendre jusqu’à 24 heures.'
);

titre2('Le compte bancaire');
para(
  'Renseignez l’IBAN du compte français dans Paramètres → Virements. Stripe peut demander à '
  + 'vérifier que vous en êtes bien le titulaire ; il compare alors le nom du titulaire et le '
  + 'numéro de compte avec les informations de votre compte Stripe.'
);

// ═══════════════════════════════════════════════════════════════════════════
//  4. LES CLÉS D'API
// ═══════════════════════════════════════════════════════════════════════════

titre1('Récupérer les clés d’API', 4);

para(
  'Toutes les clés se trouvent au même endroit : https://dashboard.stripe.com/apikeys '
  + '(Développeurs → Clés d’API). La page comporte un interrupteur entre le mode SANDBOX '
  + '(test) et le mode LIVE (réel). Chaque mode a ses propres clés, et les objets d’un mode '
  + 'sont invisibles depuis l’autre.'
);

tableau(
  ['Préfixe', 'Signification'],
  [
    ['pk_test_ / pk_live_', 'Clé publique. Sans danger dans le navigateur : elle ne permet ni d’encaisser, ni de lire les données du compte.'],
    ['sk_test_ / sk_live_', 'Clé secrète, pouvoirs illimités sur toute l’API. À garder sur le serveur uniquement.'],
    ['rk_test_ / rk_live_', 'Clé restreinte : mêmes usages, mais avec des permissions que vous choisissez. Stripe la recommande désormais à la place de la clé secrète.'],
    ['whsec_', 'Secret de signature d’un webhook. Ce n’est PAS une clé d’API — voir la section suivante.'],
  ],
  [140, LARGEUR - 140]
);

titre2('Récupérer la clé publique');
para(
  'Elle est affichée en clair sur la page, sans manipulation : copiez-la. C’est la valeur de '
  + 'STRIPE_PUBLISHABLE_KEY (côté serveur) et de VITE_STRIPE_PUBLISHABLE_KEY (côté web).'
);

titre2('Récupérer la clé serveur');
para('En mode test, toutes les clés sont visibles en permanence. En mode réel, la règle change :');
liste([
  'Vous pouvez révéler une clé que Stripe a créée pour vous : sur la page Clés d’API en mode live, cliquez « Reveal live key » en face de la clé, copiez-la, puis « Hide live key ».',
  'Une clé que vous créez vous-même n’est affichée QU’UNE FOIS. Si vous ne la copiez pas à ce moment-là, elle est définitivement perdue et il faut la remplacer par rotation.',
]);

para('Pour créer une clé secrète (si vous en avez besoin plutôt qu’une clé restreinte) :');
liste([
  'Sur la page Clés d’API, cliquez « Create secret key ».',
  'Saisissez le code de vérification que Stripe envoie par e-mail ou SMS.',
  'Donnez un nom à la clé, puis cliquez « Create ».',
  'Cliquez sur la valeur pour la copier, et enregistrez-la immédiatement : elle ne sera plus consultable.',
  'Dans « Add a note », indiquez où vous l’avez rangée, puis « Done ».',
], { etapes: true });

encadre(
  'Stripe recommande une clé restreinte plutôt qu’une clé secrète',
  'Une clé secrète a tous les droits sur votre compte. Une clé restreinte (rk_) porte '
  + 'exactement les permissions que vous lui donnez : si elle fuite, les dégâts sont bornés. '
  + 'Widjila fonctionne avec l’une comme avec l’autre — la variable s’appelle '
  + 'STRIPE_SECRET_KEY par convention, mais une clé rk_ y est acceptée. Permissions '
  + 'nécessaires : écriture sur les PaymentIntents, lecture des événements.',
  'succes'
);

titre2('Restreindre l’usage d’une clé à vos serveurs');
para(
  'Stripe permet d’attacher à une clé une « politique d’accès » qui n’autorise les requêtes '
  + 'que depuis certaines adresses IP, ou depuis un pays et un hébergeur donnés. Toute '
  + 'requête venue d’ailleurs est bloquée et vous êtes averti. Stripe recommande d’en poser '
  + 'une sur toutes les clés du mode réel. Cela se règle depuis '
  + 'https://dashboard.stripe.com/api-access-policies.'
);

// ═══════════════════════════════════════════════════════════════════════════
//  5. LE WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

titre1('Créer le webhook et récupérer whsec_', 5);

encadre(
  'C’est la pièce la plus importante de l’intégration',
  'Widjila n’active JAMAIS un abonnement parce que le navigateur affirme que le paiement a '
  + 'réussi. L’activation n’a lieu qu’en recevant de Stripe un message signé. Sans '
  + 'STRIPE_WEBHOOK_SECRET correctement renseigné, aucun paiement ne sera jamais confirmé — '
  + 'même réellement encaissé par Stripe.',
  'danger'
);

titre2('Créer le point de réception');
liste([
  'Ouvrez l’onglet Webhooks du Dashboard : https://dashboard.stripe.com/webhooks',
  'Cliquez « Create an event destination ».',
  'Choisissez « Your account » pour écouter les événements de votre propre compte.',
  'Sélectionnez la version d’API des événements.',
  'Sélectionnez les types d’événements. Pour Widjila : payment_intent.succeeded et payment_intent.payment_failed. N’en cochez pas davantage : écouter tous les événements charge inutilement votre serveur.',
  'Cliquez « Continue », puis choisissez « Webhook endpoint » comme type de destination.',
  'Renseignez l’URL du point de réception. Pour Widjila : https://votre-domaine/api/v1/abonnement/webhook',
  'Un secret commençant par whsec_ s’affiche. Cliquez « Reveal secret », copiez-le : c’est la valeur de STRIPE_WEBHOOK_SECRET.',
], { etapes: true });

encadre(
  'Un secret par endpoint, et un par mode',
  'Le secret de test et le secret de production sont DIFFÉRENTS, même pour une URL identique. '
  + 'Si vous avez plusieurs points de réception, chacun a le sien. Copier le mauvais donne une '
  + 'erreur de signature à chaque message reçu.',
  'info'
);

titre2('Contraintes techniques de l’URL');
liste([
  'L’URL doit être publiquement accessible et en HTTPS en mode réel, avec un certificat valide. Stripe n’accepte que TLS 1.2 ou 1.3.',
  'Une redirection (301, 302…) est considérée comme un échec : déclarez directement l’URL finale.',
  'Stripe réessaie pendant trois jours en mode réel, avec des délais croissants. En sandbox, trois tentatives sur quelques heures.',
  'Vous pouvez enregistrer jusqu’à 16 points de réception.',
]);

titre2('Ce que Widjila fait déjà pour vous');
liste([
  'La vérification de signature porte sur les octets bruts de la requête. Le projet capture ce corps brut avant tout parseur — c’est le piège le plus courant, et il est déjà traité.',
  'Chaque événement reçu est enregistré avant d’être traité, avec un index unique sur son identifiant. Un même message rejoué par Stripe ne peut donc pas activer deux fois le même abonnement.',
  'Le montant facturé est relu dans la base au moment de créer le paiement : un prix envoyé par le client est ignoré.',
]);

// ═══════════════════════════════════════════════════════════════════════════
//  6. TESTER
// ═══════════════════════════════════════════════════════════════════════════

titre1('Tester avant de passer en production', 6);

titre2('Recevoir les webhooks sur votre machine');
para(
  'Votre poste de développement n’a pas d’URL publique. Le CLI de Stripe fait suivre les '
  + 'événements vers votre serveur local :'
);
code([
  '# 1. Installer puis se connecter',
  'npm install -g @stripe/cli',
  'stripe login',
  '',
  '# 2. Faire suivre les evenements vers le backend local',
  'stripe listen --forward-to localhost:3000/api/v1/abonnement/webhook',
]);
para(
  'La commande affiche « Ready! Your webhook signing secret is whsec_… ». C’est CE secret '
  + 'qu’il faut mettre dans STRIPE_WEBHOOK_SECRET pendant vos tests locaux — il est distinct '
  + 'de celui du Dashboard.'
);

titre2('Déclencher un événement');
code([
  'stripe trigger payment_intent.succeeded',
]);

titre2('Cartes de test');
tableau(
  ['Numéro', 'Comportement'],
  [
    ['4242 4242 4242 4242', 'Paiement accepté. Date d’expiration future quelconque, CVC quelconque.'],
    ['4000 0000 0000 0002', 'Carte refusée par la banque émettrice.'],
    ['4000 0025 0000 3155', 'Déclenche une authentification 3D Secure.'],
  ],
  [160, LARGEUR - 160]
);

titre2('Le contrôle qui compte : le rejeu');
para(
  'Renvoyez deux fois le même événement et vérifiez qu’un seul abonnement est créé. C’est ce '
  + 'test qui prouve que la protection contre les doubles encaissements fonctionne :'
);
code([
  'stripe events resend <id_evenement>',
]);

// ═══════════════════════════════════════════════════════════════════════════
//  7. OÙ METTRE LES VALEURS
// ═══════════════════════════════════════════════════════════════════════════

titre1('Où placer chaque valeur dans le projet', 7);

titre2('backend/.env — jamais versionné');
code([
  'STRIPE_SECRET_KEY=sk_live_...        # ou rk_live_...',
  'STRIPE_PUBLISHABLE_KEY=pk_live_...',
  'STRIPE_WEBHOOK_SECRET=whsec_...',
]);

titre2('admin/.env — lu par le navigateur');
code([
  'VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...',
]);

encadre(
  'Une seule règle, et elle est absolue',
  'Seule la clé pk_ a le droit de figurer côté navigateur. Toute variable préfixée VITE_ est '
  + 'incorporée au fichier JavaScript envoyé à chaque visiteur : y placer une clé sk_ ou rk_ '
  + 'revient à la publier. Vérifiez-le après chaque build avec la commande ci-dessous, qui ne '
  + 'doit rien afficher.',
  'danger'
);
code([
  'grep -r "sk_live" admin/dist',
]);

para(
  'Si une clé secrète a été exposée, ne vous contentez pas de la retirer du code : elle est '
  + 'déjà connue. Faites-la tourner immédiatement depuis le Dashboard (menu « … » → « Rotate '
  + 'key »). Stripe laisse l’ancienne et la nouvelle valides jusqu’à 7 jours, ce qui permet de '
  + 'migrer sans coupure ; choisissez « Now » pour révoquer immédiatement.'
);

// ═══════════════════════════════════════════════════════════════════════════
//  8. ERREURS FRÉQUENTES
// ═══════════════════════════════════════════════════════════════════════════

titre1('Erreurs fréquentes et ce qu’elles signifient', 8);

tableau(
  ['Symptôme', 'Cause et remède'],
  [
    ['Erreur d’authentification', 'Clé absente, expirée, ou clé de test employée en mode réel. Vérifiez le préfixe : test et live ne sont pas interchangeables.'],
    ['Signature du webhook invalide', 'Le corps de la requête a été modifié avant la vérification, ou le secret ne correspond pas à cet endpoint / à ce mode. Rappel : le secret du CLI diffère de celui du Dashboard.'],
    ['Le webhook affiche 302 dans le Dashboard', 'Votre serveur redirige. Stripe compte une redirection comme un échec : déclarez l’URL finale.'],
    ['Le webhook affiche « Timed out »', 'Votre code répond trop tard. Renvoyez un 2xx avant tout traitement long.'],
    ['Rien ne s’active après un paiement réussi', 'Le webhook n’arrive pas. Regardez l’onglet « Event deliveries » de l’endpoint : il montre chaque tentative et le code HTTP obtenu.'],
    ['Document de vérification rejeté', 'Le plus souvent : capture d’écran, document expiré, image en noir et blanc, bordures coupées, ou nom qui ne correspond pas aux paramètres du compte.'],
    ['Clé « à accès limité »', 'Une clé inutilisée pendant plus de 180 jours pour des virements voit son accès restreint. Rétablissez-le depuis le menu « … » → « Restore access ».'],
  ],
  [165, LARGEUR - 165]
);

// ═══════════════════════════════════════════════════════════════════════════
//  9. CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════

titre1('Liste de contrôle avant la mise en production', 9);

const controles = [
  'Compte Stripe activé : la bannière de vérification a disparu de l’État du compte.',
  'IBAN français enregistré, au nom de l’entité déclarée.',
  'Libellé de relevé bancaire renseigné et reconnaissable par vos clients.',
  'STRIPE_SECRET_KEY en valeur live sur le serveur, jamais dans Git.',
  'VITE_STRIPE_PUBLISHABLE_KEY en pk_live_ côté web.',
  'Endpoint webhook déclaré en HTTPS, avec les événements payment_intent.succeeded et payment_intent.payment_failed.',
  'STRIPE_WEBHOOK_SECRET renseigné avec le secret du mode LIVE de cet endpoint.',
  'Aucune clé sk_ ni rk_ dans le build du site (grep sur admin/dist).',
  'Politique d’accès posée sur les clés live.',
  'Tarifs relus et validés dans Admin → « Prix abonnements ».',
  'Un premier paiement réel effectué de bout en bout, puis remboursé depuis Stripe.',
  'Un événement rejoué pour vérifier qu’aucun doublon n’est créé.',
  'Surveillance des webhooks en échec (table evenements_paiement, colonne erreur).',
];

controles.forEach((controle) => {
  place(26);
  const y = doc.y;
  doc.roundedRect(MARGE + 2, y + 1, 10, 10, 2).lineWidth(1).strokeColor(ORANGE).stroke();
  doc.fillColor(GRIS).font('Helvetica').fontSize(10)
    .text(controle, MARGE + 20, y, { width: LARGEUR - 20, lineGap: 2 });
  doc.moveDown(0.35);
});

// ═══════════════════════════════════════════════════════════════════════════
//  10. SOURCES
// ═══════════════════════════════════════════════════════════════════════════

titre1('Sources', 10);

para(
  'Chaque affirmation de ce guide provient des pages ci-dessous, consultées le 30 août 2026. '
  + 'En cas de divergence avec un écran de Stripe, la page officielle fait foi.'
);

liste([
  'Clés d’API — https://docs.stripe.com/keys',
  'Bonnes pratiques de gestion des clés — https://docs.stripe.com/keys-best-practices',
  'Webhooks : création, signature, rejeu — https://docs.stripe.com/webhooks',
  'Activation du compte — https://docs.stripe.com/get-started/account/activate',
  'Justificatifs acceptés par pays (sélectionner France) — https://docs.stripe.com/acceptable-verification-documents',
  'Documents de vérification d’entreprise — https://support.stripe.com/questions/documents-for-business-verification',
  'SIREN et SIRET — https://support.stripe.com/questions/siren-and-siret-numbers',
  'Erreurs de l’API — https://docs.stripe.com/api/errors',
  'Checklist de mise en production — https://docs.stripe.com/get-started/checklist/go-live',
  'Cartes de test — https://docs.stripe.com/testing',
]);

encadre(
  'Ce que ce guide ne fait pas',
  'Il ne remplace pas un conseil juridique ou comptable, et ne préjuge pas de la décision de '
  + 'Stripe : l’acceptation d’un compte relève de leur analyse de conformité. La liste exacte '
  + 'des justificatifs français n’y figure pas parce qu’elle n’a pas pu être vérifiée au '
  + 'moment de la rédaction — le Dashboard reste la source à suivre pour votre compte.',
  'info'
);

// ═══════════════════════════════════════════════════════════════════════════
//  PIEDS DE PAGE
// ═══════════════════════════════════════════════════════════════════════════

const plage = doc.bufferedPageRange();
for (let i = 0; i < plage.count; i += 1) {
  doc.switchToPage(plage.start + i);

  // La marge basse est neutralisée le temps d'écrire le pied : pdfkit ajoute
  // sinon une page vierge à chaque texte posé sous la limite.
  const margeBasse = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const y = doc.page.height - 42;
  doc.strokeColor(GRIS_CLAIR).lineWidth(0.5)
    .moveTo(MARGE, y - 8).lineTo(MARGE + LARGEUR, y - 8).stroke();

  doc.fillColor(GRIS).font('Helvetica').fontSize(8);
  doc.text('Widjila — Guide de configuration Stripe', MARGE, y, { width: LARGEUR / 2 });
  doc.text(`Page ${i + 1} / ${plage.count}`, MARGE + LARGEUR / 2, y, {
    width: LARGEUR / 2, align: 'right',
  });

  doc.page.margins.bottom = margeBasse;
}

doc.end();
process.stdout.write(`Guide genere : ${sortie}\n`);
