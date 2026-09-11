'use strict';

const { Op, QueryTypes } = require('sequelize');
const {
  Partenaire, Reserve, Utilisateur, ChantierMembre, RapportDestinataire, RapportHistorique,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const { ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const { sendEmail } = require('../../../infrastructure/emailService.js');
const rapportDiffusionTemplate = require('../../../templates/mail/rapportDiffusion.template.js');
const logger = require('../../../utils/logger.js');

const R = require('./rapportReferentiel.js');
const donnees = require('./rapportDonnees.service.js');
const RapportsService = require('./rapports.service.js');
const RapportPartageService = require('./rapportPartage.service.js');

/**
 * Diffusion d'un rapport — § 13 du cahier des charges.
 *
 * ── Deux opérations, et non une ────────────────────────────────────────────
 *
 * « Après génération, l'utilisateur clique sur Envoyer. Widjila PROPOSE les
 * destinataires, l'objet et le message. » [preparer] compose et renvoie ce
 * qui partirait, sans rien envoyer ; [envoyer] n'agit que sur confirmation.
 * Le client avait posé la règle dès la première version : rien ne part sans
 * validation de l'utilisateur.
 *
 * ── Pièce jointe ou lien ───────────────────────────────────────────────────
 *
 * « Pour un petit rapport, le PDF peut être joint. Pour un rapport lourd avec
 * beaucoup de photos, privilégier un lien sécurisé. » Le seuil est appliqué
 * sur la taille RÉELLE du fichier produit : au-delà, la pièce jointe serait
 * refusée par une partie des serveurs de messagerie, et un envoi refusé ne
 * prévient personne.
 *
 * ── Aucune adresse inventée, aucun relais ouvert (§ 21) ────────────────────
 *
 * Les destinataires possibles sont CALCULÉS par le serveur : entreprises et
 * clients de l'annuaire du chantier, membres du chantier. L'appelant choisit
 * parmi eux ; une adresse étrangère à cette liste est refusée en la nommant.
 * Sans cela, la route serait un relais capable d'expédier un document interne
 * à n'importe qui.
 */

/**
 * Au-delà de ce poids, le rapport part en LIEN plutôt qu'en pièce jointe.
 *
 * 7 Mo : la plupart des messageries d'entreprise plafonnent entre 10 et
 * 25 Mo, encodage MIME compris (+33 %). Rester dessous évite le rejet
 * silencieux, qui est le pire des cas — l'expéditeur croit avoir envoyé.
 */
const SEUIL_PIECE_JOINTE = 7 * 1024 * 1024;

/** Une adresse exploitable, ou `null`. */
function email(valeur) {
  const v = String(valeur || '').trim();
  // Contrôle volontairement minimal : le serveur de messagerie tranchera. On
  // écarte seulement ce qui n'est manifestement pas une adresse.
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

const memeAdresse = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

class RapportEnvoiService {

  /**
   * Le PÉRIMÈTRE du rapport — les mêmes filtres que ceux de sa génération.
   *
   * Partagé entre le comptage des réserves et la recherche des entreprises :
   * deux lectures divergentes annonceraient dans le courriel un nombre qui ne
   * correspondrait pas au document joint.
   */
  static _perimetre(rapport) {
    const filtres = donnees.normaliserFiltres(rapport.filtres || rapport.parametres || {});
    return donnees.construireWhere(rapport.chantierId, filtres);
  }

  /**
   * Les ENTREPRISES concernées par ce rapport.
   *
   * Trois cas, dans cet ordre :
   *  1. le rapport est un rapport PAR ENTREPRISE (§ 15) — c'est elle, et elle
   *     seule ; c'est précisément ce que le § 15 cherche à garantir ;
   *  2. les filtres visent des entreprises — ce sont celles-là ;
   *  3. sinon, celles qui portent au moins une réserve du périmètre.
   *
   * On ne remonte JAMAIS à « toutes les entreprises du chantier » : celle qui
   * n'a aucune réserve n'a rien à recevoir.
   */
  static async _entreprises(rapport) {
    if (rapport.partenaireId) {
      const p = await Partenaire.findOne({
        where: { id: rapport.partenaireId, chantierId: rapport.chantierId },
        attributes: ['id', 'nom', 'email', 'contact'],
      });
      return p ? [p] : [];
    }

    const filtres = donnees.normaliserFiltres(rapport.filtres || rapport.parametres || {});
    if (filtres.entreprises.length) {
      return Partenaire.findAll({
        where: { id: { [Op.in]: filtres.entreprises }, chantierId: rapport.chantierId },
        attributes: ['id', 'nom', 'email', 'contact'],
        order: [['nom', 'ASC']],
      });
    }

    const reserves = await Reserve.findAll({
      where: RapportEnvoiService._perimetre(rapport),
      attributes: ['id', 'partenaireId'],
    });

    const ids = uniques(reserves.map((r) => r.partenaireId).filter(Boolean));
    if (!ids.length) return [];

    return Partenaire.findAll({
      where: { id: ids },
      attributes: ['id', 'nom', 'email', 'contact'],
      order: [['nom', 'ASC']],
    });
  }

  /**
   * Les CLIENTS du chantier — ceux qui reçoivent le rapport en copie.
   *
   * Le type `client` de l'annuaire, et lui seul : mettre d'office le bureau
   * de contrôle en copie diffuserait le document au-delà de ce qui a été
   * demandé.
   */
  static async _clients(chantierId) {
    return Partenaire.findAll({
      where: { chantierId, type: 'client' },
      attributes: ['id', 'nom', 'email'],
      order: [['nom', 'ASC']],
    });
  }

  /**
   * Tout ce que l'utilisateur PEUT choisir (§ 20, « modifier les
   * destinataires » ; § 21, « validation des destinataires »).
   *
   * L'annuaire du chantier et les membres affectés au chantier. Rien d'autre
   * n'est proposé, et rien d'autre ne sera accepté à l'envoi.
   */
  static async _candidats(chantierId) {
    const [partenaires, membres] = await Promise.all([
      Partenaire.findAll({
        where: { chantierId },
        attributes: ['id', 'nom', 'email', 'type'],
        order: [['nom', 'ASC']],
      }),
      ChantierMembre.findAll({
        where: { chantierId },
        include: [{
          model: Utilisateur, as: 'utilisateur', required: true,
          attributes: ['id', 'nom', 'prenom', 'email', 'role'],
        }],
      }),
    ]);

    const candidats = [];
    for (const p of partenaires) {
      const adresse = email(p.email);
      if (adresse) candidats.push({ id: p.id, nom: p.nom, email: adresse, type: 'partenaire', role: p.type });
    }
    for (const m of membres) {
      const adresse = email(m.utilisateur?.email);
      if (!adresse) continue;
      candidats.push({
        id: m.utilisateur.id,
        nom: [m.utilisateur.prenom, m.utilisateur.nom].filter(Boolean).join(' ').trim() || adresse,
        email: adresse,
        type: 'membre',
        role: m.utilisateur.role,
      });
    }
    return candidats;
  }

  /**
   * Compose le courriel SANS l'envoyer — l'écran de vérification.
   *
   * @returns {{success: boolean, message?: string, envoi?: object}}
   */
  static async preparer(rapportId, organisationId, utilisateurId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const [entreprises, clients, candidats, auteur, nbReservesCalcule] = await Promise.all([
      RapportEnvoiService._entreprises(rapport),
      RapportEnvoiService._clients(rapport.chantierId),
      RapportEnvoiService._candidats(rapport.chantierId),
      utilisateurId
        ? Utilisateur.findByPk(utilisateurId, { attributes: ['id', 'nom', 'prenom', 'email'] })
        : null,
      rapport.nb_reserves === null || rapport.nb_reserves === undefined
        ? Reserve.count({ where: RapportEnvoiService._perimetre(rapport) })
        : Promise.resolve(rapport.nb_reserves),
    ]);

    const destinataires = entreprises.map((e) => ({ id: e.id, nom: e.nom, email: email(e.email) }));
    const copies = clients.map((c) => ({ id: c.id, nom: c.nom, email: email(c.email) }));

    const chantierNom = rapport.chantier.nom;
    const expediteur = [auteur?.prenom, auteur?.nom].filter(Boolean).join(' ').trim()
      || rapport.chantier.organisation?.nom
      || 'L’équipe chantier';

    const date = new Date(rapport.genere_le || rapport.createdAt || Date.now())
      .toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const taille = rapport.taille_pdf || 0;
    // Le § 13 laisse le choix ; le poids le tranche. L'utilisateur peut
    // toujours forcer l'autre mode à l'envoi.
    const mode = taille > SEUIL_PIECE_JOINTE ? 'lien' : 'piece_jointe';

    return {
      success: true,
      envoi: {
        rapportId: rapport.id,
        chantierNom,
        rapportNom: rapport.nom || null,
        statut: rapport.statut,
        genere: Boolean(rapport.fichier_url),
        // Objet exactement au format demandé par le client.
        objet: `Rapport de chantier – ${chantierNom} – ${date}`,
        message: [
          'Bonjour,',
          '',
          `Veuillez trouver ${mode === 'lien' ? 'ci-dessous le lien vers' : 'en pièce jointe'} le rapport de réserves concernant ${chantierNom}.`,
          Number.isInteger(nbReservesCalcule) ? `Ce rapport porte sur ${nbReservesCalcule} réserve(s).` : '',
          '',
          'Cordialement,',
          expediteur,
        ].filter((l) => l !== '').join('\n'),
        expediteur,
        // L'adresse de RÉPONSE : une entreprise qui répond « c'est levé » doit
        // atteindre la personne qui a envoyé le rapport, pas une boîte
        // technique que personne ne relève.
        expediteurEmail: email(auteur?.email),
        nbReserves: nbReservesCalcule,
        destinataires,
        copies,
        candidats,
        // Ce que l'écran doit signaler AVANT l'envoi : une entreprise sans
        // adresse ne recevra rien, et c'est réparable dans l'annuaire.
        sansEmail: [
          ...destinataires.filter((d) => !d.email).map((d) => d.nom),
          ...copies.filter((c) => !c.email).map((c) => c.nom),
        ],
        mode,
        taille,
        seuilPieceJointe: SEUIL_PIECE_JOINTE,
        pieceJointe: {
          nom: `rapport-${rapport.chantier.code || rapport.chantierId}.pdf`,
          url: rapport.fichier_url,
          taille,
        },
      },
    };
  }

  /**
   * Envoie réellement le rapport — sur confirmation de l'utilisateur.
   *
   * Les destinataires sont VÉRIFIÉS contre la liste des candidats calculée
   * par le serveur : l'appelant peut en retirer (`exclure`) ou en choisir
   * parmi les candidats, jamais en inventer.
   */
  static async envoyer(rapportId, organisationId, utilisateurId, options = {}) {
    const { cleIdempotence } = options;
    // Sans clé : comportement historique, inchangé (web, anciens clients).
    if (!cleIdempotence) return RapportEnvoiService._envoyer(rapportId, organisationId, utilisateurId, options);

    // ── Envoi IDEMPOTENT (audit synchronisation, cahier Rapports § 22) ──────
    //
    // Le mobile rejoue un envoi resté sans réponse. Sans cette garde, un
    // serveur qui avait expédié les courriels avant que la réponse ne se perde
    // les réexpédiait à chaque rejeu.
    //
    // Verrou CONSULTATIF de transaction, et non un verrou en mémoire : l'API
    // tourne en cluster PM2, deux rejeux peuvent atterrir sur deux processus.
    // `try` : un envoi déjà en cours n'attend pas — il répond 409, que le
    // mobile retentera plus tard (et trouvera alors l'envoi journalisé).
    return sequelize.transaction(async (transaction) => {
      const [ligne] = await sequelize.query(
        'SELECT pg_try_advisory_xact_lock(hashtext(:cle)) AS verrou',
        { replacements: { cle: `rapport:envoi:${cleIdempotence}` }, type: QueryTypes.SELECT, transaction },
      );
      if (!ligne || !ligne.verrou) {
        return {
          success: false,
          statusCode: 409,
          code: 'ENVOI_EN_COURS',
          message: 'Cet envoi est déjà en cours de traitement ; il sera confirmé dans quelques instants.',
        };
      }

      // Le rapport doit appartenir à l'organisation AVANT de confirmer quoi
      // que ce soit : une clé devinée ne doit rien révéler d'un autre compte.
      const rapport = await RapportsService._charger(rapportId, organisationId);
      if (!rapport) return { success: false, message: 'Rapport introuvable' };

      const deja = await RapportHistorique.findOne({
        where: {
          rapportId,
          // Seuls les envois RÉUSSIS comptent : un échec n'a rien expédié et
          // doit pouvoir être retenté avec la même clé.
          action: R.ACTIONS_HISTORIQUE.ENVOYE,
          [Op.and]: [sequelize.where(sequelize.literal("metadata->>'cleIdempotence'"), cleIdempotence)],
        },
      });
      if (deja) {
        const trace = deja.metadata || {};
        logger.info(`[rapport] Envoi rejoué (rapport ${rapportId}, clé ${cleIdempotence}) — rien n'est réexpédié`);
        return {
          success: true,
          rejeu: true,
          message: 'Ce rapport a déjà été envoyé : la demande rejouée n’a rien réexpédié.',
          envoi: { rapportId, to: trace.to || [], cc: trace.cc || [], mode: trace.mode || null },
        };
      }

      return RapportEnvoiService._envoyer(rapportId, organisationId, utilisateurId, options);
    });
  }

  /** L'envoi proprement dit — voir [envoyer] pour la garde d'idempotence. */
  static async _envoyer(rapportId, organisationId, utilisateurId, options = {}) {
    const { exclure = [], destinataires: choisis, copies: copiesChoisies, objet, message, mode: modeDemande } = options;

    const prepare = await RapportEnvoiService.preparer(rapportId, organisationId, utilisateurId);
    if (!prepare.success) return prepare;

    const { envoi } = prepare;
    const rapport = await RapportsService._charger(rapportId, organisationId);

    if (!rapport.fichier_url) {
      return { success: false, message: 'Générez le rapport avant de l’envoyer.' };
    }

    const retires = new Set(exclure.map((e) => String(e).toLowerCase()));
    const autorisees = envoi.candidats.map((c) => c.email);
    const estAutorisee = (adresse) => autorisees.some((a) => memeAdresse(a, adresse));

    // ── Destinataires ──────────────────────────────────────────────────────
    let to;
    if (Array.isArray(choisis) && choisis.length) {
      const inconnues = choisis.filter((a) => !estAutorisee(a));
      if (inconnues.length) {
        return {
          success: false,
          message: `Ces adresses ne font pas partie du chantier : ${inconnues.join(', ')}. Ajoutez-les à l’annuaire du chantier avant de les servir.`,
        };
      }
      to = uniques(choisis.filter((a) => !retires.has(String(a).toLowerCase())));
    } else {
      to = uniques(envoi.destinataires.map((d) => d.email).filter((e) => e && !retires.has(e.toLowerCase())));
    }

    let cc;
    if (Array.isArray(copiesChoisies)) {
      const inconnues = copiesChoisies.filter((a) => !estAutorisee(a));
      if (inconnues.length) {
        return {
          success: false,
          message: `Ces adresses en copie ne font pas partie du chantier : ${inconnues.join(', ')}.`,
        };
      }
      cc = uniques(copiesChoisies.filter((a) => !retires.has(String(a).toLowerCase())));
    } else {
      cc = uniques(envoi.copies.map((c) => c.email).filter((e) => e && !retires.has(e.toLowerCase())));
    }
    // Une même personne en destinataire ET en copie recevrait le rapport deux
    // fois : la comparaison est insensible à la casse, deux graphies d'une
    // adresse désignent la même boîte.
    cc = cc.filter((e) => !to.some((d) => memeAdresse(d, e)));

    if (!to.length) {
      // On ne bascule PAS sur les clients : le rapport s'adresse à
      // l'entreprise qui doit lever les réserves. Sans son adresse, il n'y a
      // personne à qui l'envoyer, et le dire vaut mieux que de l'envoyer de
      // travers.
      return {
        success: false,
        message: envoi.destinataires.length
          ? `Aucune adresse e-mail pour : ${envoi.destinataires.map((d) => d.nom).join(', ')}. Complétez l’annuaire du chantier.`
          : 'Aucune entreprise n’est rattachée aux réserves de ce rapport.',
      };
    }

    // ── Pièce jointe ou lien sécurisé (§ 13) ──────────────────────────────
    const mode = modeDemande === 'lien' || modeDemande === 'piece_jointe' ? modeDemande : envoi.mode;
    let contenu = null;
    let lien = null;
    let expireLe = null;

    if (mode === 'lien') {
      const partage = await RapportPartageService.lienPourEnvoi(rapportId, organisationId, { id: utilisateurId });
      if (!partage.success) return partage;
      lien = partage.url;
      expireLe = partage.partage.expire_le
        ? new Date(partage.partage.expire_le).toLocaleDateString('fr-FR')
        : null;
    } else {
      // Le PDF DÉJÀ produit, relu depuis le stockage : on ne le régénère pas,
      // l'utilisateur a vérifié CE document et c'est lui qui doit partir.
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
    }

    const sujet = (objet && String(objet).trim()) || envoi.objet;

    try {
      await sendEmail({
        to,
        cc,
        replyTo: envoi.expediteurEmail || undefined,
        subject: sujet,
        html: rapportDiffusionTemplate({
          chantierNom: envoi.chantierNom,
          rapportNom: envoi.rapportNom,
          expediteur: envoi.expediteur,
          nbReserves: envoi.nbReserves,
          message: message ? String(message) : null,
          lien,
          expireLe,
          organisation: rapport.chantier.organisation?.nom || null,
        }),
        attachments: contenu ? [{ filename: envoi.pieceJointe.nom, content: contenu }] : undefined,
      });
    } catch (err) {
      logger.error(
        `[rapport] Envoi échoué (rapport ${rapportId}, ${to.length} destinataire(s)) : ${err.message}`,
        { stack: err.stack },
      );
      await RapportEnvoiService._tracerDestinataires(rapportId, to, cc, mode, 'echec', err.message);
      await RapportsService._journaliser(rapportId, R.ACTIONS_HISTORIQUE.ECHEC, utilisateurId, {
        phase: 'envoi', message: err.message, destinataires: to.length,
      });
      return {
        success: false,
        message: 'L’envoi a échoué. Vérifiez les adresses e-mail et réessayez.',
      };
    }

    await RapportEnvoiService._tracerDestinataires(rapportId, to, cc, mode, 'envoye', null, envoi.candidats);

    // L'état passe à ENVOYÉ (§ 19) : c'est ce qui protège désormais le
    // document contre une réécriture silencieuse (§ 18).
    await rapport.update({ statut: R.ETATS.ENVOYE }).catch(() => {});
    await RapportsService._journaliser(rapportId, R.ACTIONS_HISTORIQUE.ENVOYE, utilisateurId, {
      to, cc, mode, objet: sujet, lien: lien ? true : false,
      // Clé d'idempotence (audit synchronisation) : c'est cette trace qu'un
      // rejeu retrouve pour répondre succès sans réexpédier. Écrite HORS de
      // la transaction du verrou, donc validée avant qu'il ne soit relâché.
      ...(options.cleIdempotence ? { cleIdempotence: options.cleIdempotence } : {}),
    });

    logger.info(
      `[rapport] Envoyé — rapport ${rapportId}, ${to.length} destinataire(s), ${cc.length} en copie, mode ${mode}`,
    );

    return {
      success: true,
      message: `Rapport envoyé à ${to.length} destinataire(s)${cc.length ? `, ${cc.length} en copie` : ''}`
        + `${mode === 'lien' ? ' (lien sécurisé)' : ''}.`,
      envoi: { to, cc, objet: sujet, mode, lien },
    };
  }

  /**
   * Enregistre QUI a reçu quoi (REPORT_RECIPIENT, § 12).
   *
   * Sans ces lignes, la seule réponse à « l'entreprise a-t-elle reçu le
   * rapport le 12 ? » serait « le serveur de messagerie le sait peut-être ».
   */
  static async _tracerDestinataires(rapportId, to, cc, mode, statut, erreur = null, candidats = []) {
    const parAdresse = new Map(candidats.map((c) => [c.email.toLowerCase(), c]));
    const lignes = [];

    const ajouter = (adresse, role) => {
      const candidat = parAdresse.get(String(adresse).toLowerCase());
      lignes.push({
        rapportId,
        email: adresse,
        role,
        nom: candidat?.nom || null,
        partenaireId: candidat?.type === 'partenaire' ? candidat.id : null,
        utilisateurId: candidat?.type === 'membre' ? candidat.id : null,
        mode,
        statut_envoi: statut,
        envoye_le: statut === 'envoye' ? new Date() : null,
        erreur,
      });
    };

    for (const adresse of to) ajouter(adresse, 'to');
    for (const adresse of cc) ajouter(adresse, 'cc');

    try {
      if (lignes.length) await RapportDestinataire.bulkCreate(lignes);
    } catch (err) {
      logger.error(`[rapport] Destinataires non tracés (${rapportId}) : ${err.message}`);
    }
  }

  /** Les envois déjà faits — pour l'écran de détail et l'historique. */
  static async destinataires(rapportId, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const lignes = await RapportDestinataire.findAll({
      where: { rapportId },
      order: [['createdAt', 'DESC']],
    });

    return { success: true, destinataires: lignes };
  }
}

module.exports = RapportEnvoiService;
module.exports.SEUIL_PIECE_JOINTE = SEUIL_PIECE_JOINTE;
