'use strict';

const {
  Rapport, Chantier, Organisation, Partenaire, Reserve, Utilisateur,
} = require('../../../models/index.js');
const { ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const { sendEmail } = require('../../../infrastructure/emailService.js');
const rapportChantierTemplate = require('../../../templates/mail/rapportChantier.template.js');
const logger = require('../../../utils/logger.js');

/**
 * Envoi d'un rapport aux entreprises, clients du chantier en copie.
 *
 * ── Pourquoi l'envoi part du SERVEUR ───────────────────────────────────────
 *
 * Le besoin tient en trois points indissociables : l'entreprise en
 * destinataire, les clients du chantier en copie, et le PDF réellement joint.
 *
 * `mailto:` ne peut pas porter de pièce jointe — c'est une limite du schéma
 * d'URL, qu'aucune application de messagerie ne contourne. La feuille de
 * partage d'Android, elle, sait joindre un fichier mais ne renseigne ni
 * destinataire ni copie de façon fiable. Aucun des deux ne tient les trois
 * points ensemble ; l'envoi serveur, si.
 *
 * ── La validation de l'utilisateur reste entière ───────────────────────────
 *
 * DEUX opérations, et non une : [preparer] compose et RENVOIE ce qui partira —
 * destinataires, copies, objet, message — sans rien envoyer. L'écran l'affiche,
 * l'utilisateur vérifie et corrige, puis confirme. [envoyer] n'agit que sur
 * cette confirmation, jamais à la génération du rapport.
 *
 * ── Aucune adresse inventée ────────────────────────────────────────────────
 *
 * Une entreprise sans email n'est pas remplacée par une autre, ni ignorée : le
 * service refuse et NOMME celles qui manquent. Envoyer un rapport de réserves
 * à la mauvaise entreprise serait pire que ne pas l'envoyer.
 */

/** Une adresse exploitable, ou `null`. */
function email(valeur) {
  const v = String(valeur || '').trim();
  // Contrôle volontairement minimal : le serveur de messagerie tranchera. On
  // écarte seulement ce qui n'est manifestement pas une adresse, pour ne pas
  // refuser une adresse valide sur un motif trop strict.
  return v.includes('@') ? v : null;
}

/** Dédoublonne en ignorant la casse, sans changer l'ordre d'apparition. */
function uniques(adresses) {
  const vus = new Set();
  const sortie = [];
  for (const a of adresses.filter(Boolean)) {
    const cle = a.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    sortie.push(a);
  }
  return sortie;
}

class RapportEnvoiService {
  /**
   * Le rapport, son chantier, et de quoi composer le courriel.
   *
   * Cloisonné par l'organisation : un identifiant deviné ne doit pas donner le
   * rapport d'un autre client, ni la liste de ses entreprises.
   */
  static async _charger(rapportId, organisationId) {
    const rapport = await Rapport.findByPk(rapportId, {
      include: [{
        model: Chantier,
        as: 'chantier',
        where: { organisationId },
        attributes: ['id', 'nom', 'code', 'organisationId'],
        include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'], required: false }],
      }],
    });
    if (!rapport || !rapport.chantier) return null;
    return rapport;
  }

  /**
   * Les ENTREPRISES concernées par ce rapport.
   *
   * Deux cas, dans cet ordre :
   *
   *  1. le rapport VISE une entreprise (`partenaireId` dans ses paramètres de
   *     génération) — c'est elle, et elle seule ;
   *  2. sinon, ce sont les entreprises qui portent au moins une réserve du
   *     périmètre. Un rapport « toutes réserves » s'adresse à tous ceux qui
   *     ont quelque chose à lever.
   *
   * On ne remonte JAMAIS à « toutes les entreprises du chantier » : celle qui
   * n'a aucune réserve n'a rien à recevoir.
   */
  /**
   * Le PÉRIMÈTRE du rapport — les mêmes filtres que ceux appliqués lors de sa
   * génération (voir rapport.service.js).
   *
   * Partagé entre le comptage des réserves et la recherche des entreprises :
   * deux lectures divergentes annonceraient dans le courriel un nombre qui ne
   * correspondrait pas au PDF joint.
   */
  static _perimetre(rapport) {
    const params = rapport.parametres || {};
    const ou = { chantierId: rapport.chantierId };
    if (params.statut) ou.statut = params.statut;
    if (params.batimentId) ou.batimentId = params.batimentId;
    if (params.phaseId) ou.phaseId = params.phaseId;
    if (params.corpsEtatId) ou.corpsEtatId = params.corpsEtatId;
    if (params.partenaireId) ou.partenaireId = params.partenaireId;
    return ou;
  }

  static async _entreprises(rapport) {
    const params = rapport.parametres || {};

    if (params.partenaireId) {
      const p = await Partenaire.findOne({
        where: { id: params.partenaireId, chantierId: rapport.chantierId },
        attributes: ['id', 'nom', 'email'],
      });
      return p ? [p] : [];
    }

    // Les réserves du périmètre, réduites à leurs entreprises distinctes.
    const reserves = await Reserve.findAll({
      where: RapportEnvoiService._perimetre(rapport),
      attributes: ['id', 'partenaireId'],
    });

    const ids = uniques(reserves.map((r) => r.partenaireId).filter(Boolean));
    if (!ids.length) return [];

    return Partenaire.findAll({
      where: { id: ids },
      attributes: ['id', 'nom', 'email'],
      order: [['nom', 'ASC']],
    });
  }

  /**
   * Les CLIENTS du chantier — ceux qui reçoivent le rapport en copie.
   *
   * Le type `client` de l'annuaire du chantier, et lui seul : le maître
   * d'ouvrage ou le bureau de contrôle ont leur propre circuit, les mettre en
   * copie d'office diffuserait un document au-delà de ce qui a été demandé.
   */
  static async _clients(chantierId) {
    return Partenaire.findAll({
      where: { chantierId, type: 'client' },
      attributes: ['id', 'nom', 'email'],
      order: [['nom', 'ASC']],
    });
  }

  /**
   * Compose le courriel SANS l'envoyer — l'écran de vérification.
   *
   * @returns {{success: boolean, message?: string, envoi?: object}}
   */
  static async preparer(rapportId, organisationId, utilisateurId) {
    const rapport = await RapportEnvoiService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const [entreprises, clients, auteur, nbReserves] = await Promise.all([
      RapportEnvoiService._entreprises(rapport),
      RapportEnvoiService._clients(rapport.chantierId),
      utilisateurId
        ? Utilisateur.findByPk(utilisateurId, { attributes: ['id', 'nom', 'prenom', 'email'] })
        : null,
      Reserve.count({ where: RapportEnvoiService._perimetre(rapport) }),
    ]);

    const destinataires = entreprises.map((e) => ({
      id: e.id, nom: e.nom, email: email(e.email),
    }));
    const copies = clients.map((c) => ({ id: c.id, nom: c.nom, email: email(c.email) }));

    const chantierNom = rapport.chantier.nom;
    const expediteur = [auteur?.prenom, auteur?.nom].filter(Boolean).join(' ').trim()
      || rapport.chantier.organisation?.nom
      || 'L’équipe chantier';

    const date = new Date(rapport.createdAt || Date.now())
      .toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    return {
      success: true,
      envoi: {
        rapportId: rapport.id,
        chantierNom,
        // Objet exactement tel que demandé.
        objet: `Rapport de chantier – ${chantierNom} – ${date}`,
        message: [
          'Bonjour,',
          '',
          `Veuillez trouver en pièce jointe le rapport de chantier concernant ${chantierNom}.`,
          'Ce rapport contient l’ensemble des réserves enregistrées à ce jour.',
          '',
          'Cordialement,',
          expediteur,
        ].join('\n'),
        expediteur,
        // L'adresse de RÉPONSE. Une entreprise qui répond « c'est levé » doit
        // atteindre la personne qui a envoyé le rapport, pas la boîte
        // technique de la plateforme, que personne ne relève.
        expediteurEmail: email(auteur?.email),
        nbReserves,
        destinataires,
        copies,
        // Ce que l'écran doit signaler AVANT l'envoi : une entreprise sans
        // adresse ne recevra rien, et c'est à l'utilisateur de la compléter
        // dans l'annuaire du chantier.
        sansEmail: [
          ...destinataires.filter((d) => !d.email).map((d) => d.nom),
          ...copies.filter((c) => !c.email).map((c) => c.nom),
        ],
        pieceJointe: {
          nom: `rapport-${rapport.chantier.code || rapport.chantierId}.pdf`,
          url: rapport.fichier_url,
        },
      },
    };
  }

  /**
   * Envoie réellement le rapport — sur confirmation de l'utilisateur.
   *
   * Les destinataires sont RECALCULÉS côté serveur : accepter la liste envoyée
   * par le client ferait de cette route un relais de courriel ouvert, capable
   * d'expédier un document interne à n'importe quelle adresse. L'appelant peut
   * en RETIRER (`exclure`), jamais en ajouter.
   */
  static async envoyer(rapportId, organisationId, utilisateurId, { exclure = [] } = {}) {
    const prepare = await RapportEnvoiService.preparer(rapportId, organisationId, utilisateurId);
    if (!prepare.success) return prepare;

    const { envoi } = prepare;
    const retires = new Set(exclure.map((e) => String(e).toLowerCase()));

    const to = uniques(
      envoi.destinataires.map((d) => d.email).filter((e) => e && !retires.has(e.toLowerCase())),
    );
    const cc = uniques(
      envoi.copies.map((c) => c.email).filter((e) => e && !retires.has(e.toLowerCase())),
      // Comparaison INSENSIBLE À LA CASSE : `Contact@ex.fr` et `contact@ex.fr`
      // sont la même boîte. Un test `includes` brut mettait la même personne
      // en destinataire ET en copie — elle recevait le rapport deux fois.
    ).filter((e) => !to.some((d) => d.toLowerCase() === e.toLowerCase()));

    if (!to.length) {
      // On ne bascule PAS sur les clients : le rapport s'adresse à l'entreprise
      // qui doit lever les réserves. Sans son adresse, il n'y a personne à qui
      // l'envoyer, et le dire vaut mieux que de l'envoyer de travers.
      return {
        success: false,
        message: envoi.destinataires.length
          ? `Aucune adresse e-mail pour : ${envoi.destinataires.map((d) => d.nom).join(', ')}. Complétez l’annuaire du chantier.`
          : 'Aucune entreprise n’est rattachée aux réserves de ce rapport.',
      };
    }

    const rapport = await RapportEnvoiService._charger(rapportId, organisationId);

    // La PIÈCE JOINTE : le PDF déjà produit, relu depuis le stockage. On ne le
    // régénère pas — l'utilisateur a vérifié CE document, c'est lui qui doit
    // partir.
    let contenu;
    try {
      const fichier = await ouvrirFichier(rapport.fichier_url);
      if (!fichier || !fichier.stream) throw new Error('flux indisponible');
      const morceaux = [];
      for await (const bloc of fichier.stream) morceaux.push(bloc);
      contenu = Buffer.concat(morceaux);
    } catch (err) {
      logger.error(
        `[rapport] Pièce jointe illisible (rapport ${rapportId}) : ${err.message}`,
        { stack: err.stack },
      );
      return {
        success: false,
        message: 'Le fichier du rapport est introuvable. Générez-le à nouveau, puis renvoyez-le.',
      };
    }

    try {
      await sendEmail({
        to,
        cc,
        replyTo: envoi.expediteurEmail || undefined,
        subject: envoi.objet,
        html: rapportChantierTemplate({
          chantierNom: envoi.chantierNom,
          expediteur: envoi.expediteur,
          nbReserves: envoi.nbReserves,
        }),
        attachments: [{ filename: envoi.pieceJointe.nom, content: contenu }],
      });
    } catch (err) {
      logger.error(
        `[rapport] Envoi échoué (rapport ${rapportId}, ${to.length} destinataire(s)) : ${err.message}`,
        { stack: err.stack },
      );
      return {
        success: false,
        message: 'L’envoi a échoué. Vérifiez les adresses e-mail et réessayez.',
      };
    }

    logger.info(
      `[rapport] Envoyé — rapport ${rapportId}, ${to.length} destinataire(s), ${cc.length} en copie`,
    );

    return {
      success: true,
      message: `Rapport envoyé à ${to.length} entreprise(s)${cc.length ? `, ${cc.length} client(s) en copie` : ''}.`,
      envoi: { to, cc, objet: envoi.objet },
    };
  }
}

module.exports = RapportEnvoiService;
