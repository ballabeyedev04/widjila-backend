'use strict';

const definirReferentielType = require('./referentielType.model.js');

/**
 * Référentiel des types d'intervenant — administrable.
 *
 * Structure, portée et règles : voir `referentielType.model.js`, qui les
 * décrit une seule fois pour les trois référentiels de type.
 *
 * Le `code` de chaque ligne est la valeur écrite dans la colonne métier
 * correspondante ; le catalogue standard reprend les valeurs de l'ancien
 * `ENUM`, de sorte que les données déjà en base restent valides.
 */
module.exports = definirReferentielType('TypePartenaire', 'types_partenaire');
