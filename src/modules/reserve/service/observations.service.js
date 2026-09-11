'use strict';

const { Op } = require('sequelize');
const { Reserve, Chantier } = require('../../../models/index.js');

/**
 * Observations déjà saisies — historique servant de SUGGESTIONS au champ
 * « Observation » de la création d'une réserve.
 *
 * ## Périmètre : les réserves que l'utilisateur a LUI-MÊME relevées
 *
 * Et seulement dans son organisation actuelle. Proposer les observations de
 * toute l'organisation exposerait le texte de chantiers auxquels il n'a pas
 * accès (cloisonnement par chantier) ; son propre historique ne lui apprend
 * rien qu'il ne sache déjà. C'est aussi ce que l'on attend d'une suggestion :
 * retrouver SES formulations habituelles (« coins cassés », « joint à
 * reprendre »).
 *
 * ## Pas de nouvelle table
 *
 * L'historique EST la colonne `reserves.description` : rien à synchroniser,
 * rien qui diverge. Les réserves supprimées sont exclues d'office (modèle
 * `paranoid`).
 */

/** Une observation plus longue n'est pas une formule qu'on réutilise : c'est un rapport. */
const LONGUEUR_MAX_SUGGESTION = 300;

/** Réserves les plus récentes examinées — l'historique utile d'une personne. */
const LIGNES_LUES = 500;

/**
 * Forme de comparaison : minuscules, sans accents, espaces réduits.
 * « Coins  CASSÉS » et « coins cassés » sont la même observation.
 */
function normaliser(texte) {
  return String(texte || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La saisie correspond-elle à l'observation ?
 *
 * Vrai si l'observation COMMENCE par la saisie (« coi » → « coins casse »),
 * ou si chaque mot saisi est le DÉBUT d'un mot de l'observation
 * (« cas » → « coins casse »). Une simple inclusion (« ns » → « coins »)
 * proposerait des suggestions sans rapport avec ce que l'on tape.
 */
function correspond(observation, saisie) {
  if (!saisie) return true;
  if (observation.startsWith(saisie)) return true;
  const mots = observation.split(' ');
  return saisie.split(' ').every((fragment) => mots.some((mot) => mot.startsWith(fragment)));
}

class ObservationsService {
  /**
   * @param {{ id: string, organisationId: string|null }} utilisateur
   * @param {{ q?: string, limit?: number }} options
   * @returns {Promise<{ success: true, observations: string[] }>}
   */
  static async listerObservationsUtilisees(utilisateur, { q = '', limit = 50 } = {}) {
    if (!utilisateur?.id || !utilisateur.organisationId) return { success: true, observations: [] };

    const lignes = await Reserve.findAll({
      where: { creePar: utilisateur.id, description: { [Op.ne]: null } },
      attributes: ['description', 'createdAt'],
      include: [{
        model: Chantier,
        as: 'chantier',
        attributes: [],
        where: { organisationId: utilisateur.organisationId },
        required: true,
      }],
      order: [['createdAt', 'DESC']],
      limit: LIGNES_LUES,
      raw: true,
    });

    // Regroupement : une même observation (casse, accents, espaces près)
    // n'apparaît qu'une fois, sous sa formulation la plus RÉCENTE.
    const vues = new Map();
    for (const { description } of lignes) {
      const texte = String(description || '').trim();
      if (!texte || texte.length > LONGUEUR_MAX_SUGGESTION) continue;
      const cle = normaliser(texte);
      const deja = vues.get(cle);
      if (deja) {
        deja.usages += 1;
      } else {
        vues.set(cle, { texte, cle, usages: 1, rang: vues.size });
      }
    }

    const saisie = normaliser(q);
    const retenues = [...vues.values()].filter((v) => correspond(v.cle, saisie));
    retenues.sort((a, b) => {
      if (saisie) {
        const debutA = a.cle.startsWith(saisie) ? 0 : 1;
        const debutB = b.cle.startsWith(saisie) ? 0 : 1;
        if (debutA !== debutB) return debutA - debutB;
      }
      // Les formules les plus employées d'abord, puis les plus récentes.
      return b.usages - a.usages || a.rang - b.rang;
    });

    return { success: true, observations: retenues.slice(0, limit).map((v) => v.texte) };
  }
}

module.exports = ObservationsService;
module.exports.normaliser = normaliser;
module.exports.correspond = correspond;
