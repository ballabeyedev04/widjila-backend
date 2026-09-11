'use strict';

const Joi = require('joi');

/**
 * `GET /sync/reserves` — tirage INCRÉMENTAL des réserves pour le mobile.
 *
 * `curseur` est opaque pour le client : il le reçoit de la page précédente et
 * le renvoie tel quel. Absent (ou vide) : tirage complet depuis l'origine.
 *
 * `limite` borne une page. 500 au plus : au-delà, une page sur un réseau de
 * chantier dépasserait le délai de réponse du mobile, et un tirage qui
 * n'aboutit jamais vaut moins que plusieurs pages qui aboutissent.
 */
const syncReservesQuery = Joi.object({
  curseur: Joi.string().trim().max(512).allow('').optional(),
  limite: Joi.number().integer().min(1).max(500).default(200),
});

module.exports = { syncReservesQuery };
