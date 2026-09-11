'use strict';

const crypto = require('crypto');
const { RapportPartage, Rapport, Chantier, Organisation } = require('../../../models/index.js');
const { ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');
const R = require('./rapportReferentiel.js');
const RapportsService = require('./rapports.service.js');

/**
 * Partage par LIEN SÉCURISÉ — § 14 du cahier des charges.
 *
 * Le document fixe six exigences ; chacune est tenue ici :
 *
 *   unique et difficile à deviner  → 32 octets tirés de `crypto.randomBytes`,
 *                                    soit 256 bits : deviner un lien est hors
 *                                    de portée, même en essayant sans relâche ;
 *   associé au report_id           → le jeton ne donne accès qu'à CE rapport ;
 *   révocable                      → `revoque_le`, effet immédiat ;
 *   limité dans le temps           → `expire_le`, facultatif ;
 *   protégé par authentification   → `authentification_requise` ;
 *   accès journalisés              → compteur, date, et une ligne d'historique
 *                                    par consultation (§ 18).
 *
 * ── Le jeton n'est jamais stocké en clair ──────────────────────────────────
 *
 * Seule son empreinte SHA-256 est enregistrée. Une copie de la base ne rend
 * donc pas utilisables les liens déjà distribués — or ces liens ouvrent des
 * documents contractuels sans demander d'identifiants. Le jeton en clair
 * n'existe qu'une fois : dans la réponse à la demande de partage.
 */

/** Durée de vie par défaut d'un lien créé pour accompagner un envoi. */
const JOURS_EXPIRATION_ENVOI = 30;
// Durée d'un lien créé sans durée explicite, et plafond absolu.
const JOURS_EXPIRATION_DEFAUT = 30;
const JOURS_EXPIRATION_MAX = 365;

const empreinte = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Base des liens publics.
 *
 * `RAPPORT_LIEN_BASE` permet de servir la forme courte du § 14
 * (`widjila.app/r/{token}`) quand le domaine est configuré pour. À défaut, on
 * s'appuie sur l'URL publique de l'API : elle est toujours joignable, ce qui
 * vaut mieux qu'un lien élégant qui ne mène nulle part.
 */
function baseLiens() {
  const explicite = process.env.RAPPORT_LIEN_BASE;
  if (explicite) return explicite.replace(/\/+$/, '');
  const api = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  return `${api}/api/v1/r`;
}

class RapportPartageService {

  /** § 9 — POST /reports/{id}/share. */
  static async creer(rapportId, organisationId, utilisateur, options = {}) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    if (!rapport.fichier_url) {
      // Partager un rapport non généré donnerait un lien qui ouvre le vide.
      return { success: false, message: 'Générez le rapport avant de le partager.' };
    }
    // Un fichier PÉRIMÉ ne se partage pas plus qu'il ne s'envoie (voir
    // `rapportEnvoi.service.js#envoyer`) : un rapport modifié après génération
    // repasse en brouillon avec l'ancien PDF, et le lien aurait diffusé une
    // version que la configuration ne décrit plus.
    if (![R.ETATS.GENERE, R.ETATS.ENVOYE].includes(rapport.statut)) {
      return { success: false, message: 'Régénérez le rapport avant de le partager : sa configuration a changé depuis le dernier fichier.' };
    }

    const token = crypto.randomBytes(32).toString('base64url');
    // Plus de lien ÉTERNEL par défaut : sans durée, le lien vivait
    // indéfiniment — y compris après le départ de l'organisation. La durée
    // demandée reste bornée par le schéma (1 à 365 jours).
    const demandee = Number(options.expireDansJours);
    const jours = Number.isFinite(demandee) && demandee > 0
      ? Math.min(demandee, JOURS_EXPIRATION_MAX)
      : JOURS_EXPIRATION_DEFAUT;
    const expire = new Date(Date.now() + jours * 24 * 60 * 60 * 1000);

    const partage = await RapportPartage.create({
      rapportId: rapport.id,
      token_hash: empreinte(token),
      creePar: utilisateur?.id || null,
      expire_le: expire,
      authentification_requise: Boolean(options.authentificationRequise),
    });

    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.PARTAGE, utilisateur?.id, {
      partageId: partage.id,
      expireLe: expire,
      authentificationRequise: partage.authentification_requise,
    });

    logger.info(`[rapport] Lien de partage créé — rapport ${rapport.id}, expire ${expire || 'jamais'}`);

    return {
      success: true,
      partage,
      // Le jeton EN CLAIR, une seule fois : il n'est plus récupérable ensuite.
      token,
      url: `${baseLiens()}/${token}`,
    };
  }

  static async lister(rapportId, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const partages = await RapportPartage.findAll({
      where: { rapportId },
      attributes: [
        'id', 'expire_le', 'revoque_le', 'nb_acces', 'dernier_acces_le',
        'authentification_requise', 'createdAt',
      ],
      order: [['createdAt', 'DESC']],
    });

    return {
      success: true,
      partages: partages.map((p) => ({
        id: p.id,
        expireLe: p.expire_le,
        revoqueLe: p.revoque_le,
        nbAcces: p.nb_acces,
        dernierAccesLe: p.dernier_acces_le,
        authentificationRequise: p.authentification_requise,
        actif: p.estValide(),
        creeLe: p.createdAt,
      })),
    };
  }

  /** Révocation — immédiate, et journalisée comme le reste (§ 14, § 18). */
  static async revoquer(rapportId, partageId, organisationId, utilisateur) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const partage = await RapportPartage.findOne({ where: { id: partageId, rapportId } });
    if (!partage) return { success: false, message: 'Lien de partage introuvable' };

    if (!partage.revoque_le) {
      await partage.update({ revoque_le: new Date() });
      await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.PARTAGE_REVOQUE, utilisateur?.id, {
        partageId: partage.id,
      });
    }

    return { success: true, message: 'Lien révoqué' };
  }

  /**
   * Ouvre un rapport à partir de son jeton public.
   *
   * ── Ce que cette méthode refuse, et pourquoi ───────────────────────────
   *
   * Un jeton inconnu, révoqué ou expiré reçoit le MÊME message qu'un jeton
   * qui n'a jamais existé : distinguer « révoqué » de « inexistant »
   * confirmerait à un inconnu qu'un document existe bel et bien derrière ce
   * lien. Un lien protégé par authentification exige en plus un compte de
   * l'organisation propriétaire.
   */
  static async ouvrir(token, { utilisateur = null, ip = null, userAgent = null } = {}) {
    const refus = { success: false, message: 'Ce lien n’est plus valide.' };
    if (!token) return refus;

    const partage = await RapportPartage.findOne({
      where: { token_hash: empreinte(token) },
      include: [{
        model: Rapport, as: 'rapport', required: true,
        include: [{
          model: Chantier, as: 'chantier', required: true,
          attributes: ['id', 'nom', 'code', 'organisationId'],
          include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'], required: false }],
        }],
      }],
    });

    if (!partage || !partage.estValide()) return refus;

    const rapport = partage.rapport;
    if (!rapport || !rapport.fichier_url) return refus;

    if (partage.authentification_requise) {
      const memeOrganisation = utilisateur
        && String(utilisateur.organisationId) === String(rapport.chantier.organisationId);
      if (!memeOrganisation && utilisateur?.role !== 'Admin') {
        return {
          success: false,
          authentificationRequise: true,
          message: 'Ce rapport est protégé : connectez-vous avec le compte destinataire pour l’ouvrir.',
        };
      }
    }

    const fichier = await ouvrirFichier(rapport.fichier_url);
    if (!fichier || !fichier.stream) {
      return { success: false, message: 'Le fichier de ce rapport est introuvable.' };
    }

    // Journalisation : le compteur pour l'écran, la ligne d'historique pour
    // la traçabilité demandée au § 18 (« Rapport consulté via lien »).
    await partage.update({
      nb_acces: (partage.nb_acces || 0) + 1,
      dernier_acces_le: new Date(),
    }).catch(() => {});

    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.CONSULTE_VIA_LIEN, utilisateur?.id || null, {
      partageId: partage.id,
      ip: ip || null,
      // Tronqué : un en-tête de navigateur peut faire plusieurs centaines de
      // caractères, et seul son début identifie l'appareil.
      userAgent: userAgent ? String(userAgent).slice(0, 180) : null,
      authentifie: Boolean(utilisateur),
    });

    logger.info(
      `[rapport] Consulté via lien — rapport ${rapport.id}, partage ${partage.id}, ip ${ip || 'inconnue'}`,
    );

    return {
      success: true,
      rapport,
      stream: fichier.stream,
      taille: fichier.taille,
      contentType: 'application/pdf',
      nom: `${rapport.nom || 'rapport'}.pdf`.replace(/[^\w.\-]+/g, '-'),
    };
  }

  /**
   * Lien prêt à être glissé dans un courriel (§ 13, cas du rapport lourd).
   *
   * Réutilise un lien existant encore valable plutôt que d'en créer un à
   * chaque envoi : multiplier les jetons multiplie les portes à révoquer le
   * jour où le rapport ne doit plus circuler.
   */
  static async lienPourEnvoi(rapportId, organisationId, utilisateur) {
    const existants = await RapportPartage.findAll({
      where: { rapportId, revoque_le: null },
      order: [['createdAt', 'DESC']],
    });
    const valide = existants.find((p) => p.estValide());
    if (valide) {
      // Le jeton en clair n'est plus connu : un lien réutilisable doit donc
      // être recréé. On révoque le plus récent pour ne pas laisser deux portes
      // ouvertes sur le même document. Les liens créés À LA MAIN (durée
      // longue, authentification exigée) ne sont pas touchés : les révoquer
      // en silence à chaque envoi casserait ce que l'utilisateur a remis.
      await valide.update({ revoque_le: new Date() }).catch(() => {});
    }

    return RapportPartageService.creer(rapportId, organisationId, utilisateur, {
      expireDansJours: JOURS_EXPIRATION_ENVOI,
    });
  }
}

module.exports = RapportPartageService;
module.exports._interne = {
  empreinte, baseLiens, JOURS_EXPIRATION_ENVOI, JOURS_EXPIRATION_DEFAUT, JOURS_EXPIRATION_MAX,
};
