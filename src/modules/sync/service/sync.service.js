'use strict';

const { Op } = require('sequelize');
const {
  Reserve, ReservePosition, Chantier, Batiment, Etage, Zone, Lot, CorpsEtat, Phase,
  Organisation, Partenaire, Utilisateur, Media,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const ChantierService = require('../../chantier/service/chantier.service.js');

/**
 * Synchronisation INCRÉMENTALE des réserves vers le mobile (audit
 * synchronisation — « tirage » après la vidange de la file d'attente).
 *
 * ## Le défaut corrigé
 *
 * Le mobile ne connaissait les réserves que par les listes paginées qu'il
 * affichait. Deux conséquences :
 *
 *   1. une réserve SUPPRIMÉE sur le serveur (par le web, par un autre
 *      appareil) restait dans le cache local et RÉAPPARAISSAIT au premier
 *      passage hors ligne, sans que rien ne puisse la faire partir ;
 *   2. une réserve modifiée ailleurs n'était rafraîchie que si l'écran qui la
 *      montrait était rouvert en ligne — hors ligne, on consultait un état
 *      périmé sans le savoir.
 *
 * ## Le principe
 *
 * Chaque réserve porte une MARQUE de changement : la plus récente de sa date
 * de mise à jour et de sa date de suppression. Les réserves supprimées sont
 * lues aussi (`paranoid: false`) : elles deviennent des « pierres tombales »
 * que le mobile applique en effaçant sa copie.
 *
 * Le curseur est le couple (marque, id) de la dernière ligne servie. L'id
 * départage les lignes de même marque — sans lui, une page qui s'arrête au
 * milieu d'un lot de même horodatage perdrait le reste du lot.
 *
 * ## L'horizon
 *
 * Une transaction encore ouverte peut valider plus tard une ligne dont la
 * marque est ANTÉRIEURE au curseur déjà servi : elle serait sautée pour
 * toujours. Le tirage s'arrête donc à « maintenant − 5 s » ; ce qui est plus
 * récent sera servi au tirage suivant, une fois les transactions en vol
 * terminées.
 *
 * ## La précision
 *
 * La marque voyage en texte à la MICROSECONDE (précision de PostgreSQL). Une
 * date JavaScript, à la milliseconde, ferait resservir en boucle la dernière
 * ligne d'une page.
 */

const MARQUE_SQL = 'GREATEST("Reserve"."updated_at", COALESCE("Reserve"."deleted_at", "Reserve"."updated_at"))';
const MARQUE_TEXTE_SQL = `to_char(${MARQUE_SQL} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const MARGE_HORIZON_MS = 5000;
const ORIGINE = Object.freeze({ m: '1970-01-01T00:00:00.000000Z', i: '00000000-0000-0000-0000-000000000000' });

const FORMAT_MARQUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const FORMAT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encoderCurseur({ m, i }) {
  return Buffer.from(JSON.stringify({ m, i }), 'utf8').toString('base64url');
}

/** Curseur décodé et VÉRIFIÉ — `null` s'il est illisible ou forgé. */
function decoderCurseur(brut) {
  if (!brut) return ORIGINE;
  try {
    const { m, i } = JSON.parse(Buffer.from(String(brut), 'base64url').toString('utf8'));
    // Les deux valeurs finissent dans du SQL : on n'accepte que leur forme
    // exacte, en plus de l'échappement.
    if (typeof m !== 'string' || !FORMAT_MARQUE.test(m)) return null;
    if (typeof i !== 'string' || !FORMAT_UUID.test(i)) return null;
    return { m, i };
  } catch (_) {
    return null;
  }
}

class SyncService {
  /**
   * Une page de changements de réserves pour l'organisation de l'appelant.
   *
   * @param {string} organisationId
   * @param {object} auteur  Compte appelant — sert au cloisonnement par chantier.
   * @param {{ curseur?: string, limite?: number }} requete
   */
  static async deltaReserves(organisationId, auteur, { curseur: curseurBrut, limite = 200 } = {}) {
    const curseur = decoderCurseur(curseurBrut);
    if (!curseur) return { success: false, message: 'Curseur de synchronisation invalide : relancez un tirage complet.' };

    const horizon = new Date(Date.now() - MARGE_HORIZON_MS);

    // Même périmètre que la liste transversale des réserves : l'organisation,
    // puis le cloisonnement par chantier du compte.
    const whereChantier = { organisationId };
    const cloisonnement = ChantierService.filtreCloisonnement(auteur);
    if (cloisonnement) Object.assign(whereChantier, cloisonnement);

    const lignes = await Reserve.findAll({
      paranoid: false,
      attributes: { include: [[sequelize.literal(MARQUE_TEXTE_SQL), 'marqueSync']] },
      where: {
        [Op.and]: [
          sequelize.literal(
            `(${MARQUE_SQL}, "Reserve"."id") > (CAST(${sequelize.escape(curseur.m)} AS timestamptz), CAST(${sequelize.escape(curseur.i)} AS uuid))`,
          ),
          sequelize.literal(`${MARQUE_SQL} <= CAST(${sequelize.escape(horizon.toISOString())} AS timestamptz)`),
        ],
      },
      include: [
        {
          model: Chantier, as: 'chantier', required: true, paranoid: false,
          attributes: ['id', 'nom', 'code', 'deletedAt'],
          where: whereChantier,
          include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'] }],
        },
        { model: ReservePosition, as: 'position' },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
        // Même vignette que les listes : le cache local doit pouvoir afficher
        // la carte hors ligne comme en ligne.
        { model: Media, as: 'medias', attributes: ['id', 'type', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [[sequelize.literal(MARQUE_SQL), 'ASC'], ['id', 'ASC']],
      // Une ligne de plus que demandé : sa présence dit s'il reste une page.
      limit: limite + 1,
    });

    const page = lignes.slice(0, limite);
    const modifiees = [];
    const supprimees = [];
    for (const ligne of page) {
      const { marqueSync, ...donnees } = ligne.toJSON();
      // Une réserve dont le CHANTIER est supprimé est tout aussi morte pour le
      // mobile : elle ne doit plus s'afficher.
      const supprimeeLe = donnees.deletedAt || donnees.chantier?.deletedAt || null;
      if (supprimeeLe) supprimees.push({ id: donnees.id, supprimeeLe });
      else modifiees.push(donnees);
    }

    const derniere = page[page.length - 1];
    return {
      success: true,
      modifiees,
      supprimees,
      curseur: derniere ? encoderCurseur({ m: derniere.get('marqueSync'), i: derniere.id }) : encoderCurseur(curseur),
      termine: lignes.length <= limite,
    };
  }
}

SyncService._decoderCurseur = decoderCurseur;
SyncService._encoderCurseur = encoderCurseur;
SyncService.ORIGINE = ORIGINE;

module.exports = SyncService;
