'use strict';

const { Op } = require('sequelize');

/** Lignes supprimées par ordre DELETE — assez pour avancer, assez peu pour tenir sous le délai. */
const TAILLE_LOT = 5000;

/**
 * Supprime par LOTS les lignes de [Modele] qui satisfont [where].
 *
 * La base impose un délai par requête (`statement_timeout`, voir
 * `config/db.js`) : un seul `DELETE` sur des mois de journaux accumulés
 * dépassait ce délai, était annulé, et la purge échouait chaque semaine sans
 * que l'arriéré ne diminue jamais. Par lots, chaque ordre reste court, et une
 * interruption laisse la purge avancée d'autant.
 *
 * @param {import('sequelize').ModelStatic<any>} Modele  modèle à clé `id`
 * @param {object} where  condition Sequelize
 * @param {{ taille?: number }} [options]
 * @returns {Promise<number>} nombre total de lignes supprimées
 */
async function supprimerParLots(Modele, where, { taille = TAILLE_LOT } = {}) {
  let total = 0;
  for (;;) {
    const lot = await Modele.findAll({ where, attributes: ['id'], limit: taille, raw: true });
    if (!lot.length) return total;

    const supprimees = await Modele.destroy({ where: { id: { [Op.in]: lot.map((l) => l.id) } } });
    total += supprimees;

    // Lot partiel : il n'y a plus rien derrière. Rien supprimé : on s'arrête
    // plutôt que de relire indéfiniment les mêmes lignes.
    if (lot.length < taille || supprimees === 0) return total;
  }
}

module.exports = { supprimerParLots, TAILLE_LOT };
