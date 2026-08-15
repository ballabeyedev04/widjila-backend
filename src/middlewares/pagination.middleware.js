'use strict';

/**
 * pagination.middleware.js — Normalisation ET PLAFONNEMENT de la pagination.
 *
 * ── Cause du correctif ──────────────────────────────────────────────────────
 * Toutes les listes (`ChantierService.listChantiers`, `ReserveService.listReserves`,
 * `OrganisationService.listMembres`, `GestionUtilisateurService.listUtilisateurs`…)
 * recevaient `req.query` BRUT, non validé. Leurs signatures ne posent qu'un défaut
 * (`{ page = 1, limit = 20 }`) : dès que le client envoie `?limit=500000`, la valeur
 * part telle quelle dans `findAndCountAll({ limit, offset })`, avec jusqu'à une
 * dizaine de jointures `include`. Une seule requête suffit alors à saturer la base
 * et la RAM du process (déni de service non authentifié au sein de l'organisation).
 *
 * Le schéma `paginationQuery` de `src/validations/common.js` plafonnait bien à 100…
 * mais il n'était importé NULLE PART : du code mort.
 *
 * ── Pourquoi un middleware et pas `validate(paginationQuery, 'query')` ──────
 * Sous Express 5, `req.query` est un GETTER non mémoïsé défini sur le prototype
 * `app.request` : chaque lecture reparse la query string et retourne un OBJET NEUF.
 * Le `Object.assign(req.query, value)` de `validate.middleware.js` mute donc un
 * objet immédiatement jeté — la validation `'query'` est intégralement inopérante.
 * Poser `validate(paginationQuery, 'query')` sur les routes n'aurait rien plafonné.
 *
 * ── Voie retenue (robuste) ──────────────────────────────────────────────────
 * On ne mute pas le résultat du getter : on définit sur l'instance `req` une
 * PROPRIÉTÉ PROPRE `query` (data property) qui masque le getter du prototype.
 * L'écriture est donc persistante pour toute la durée de la requête, en Express 4
 * comme en Express 5, sans toucher au middleware `validate` (possédé ailleurs).
 *
 * Deux sorties, volontairement redondantes :
 *   1. `req.pagination = { page, limit, offset }` — source canonique, à consommer
 *      par les services (voir la note de migration ci-dessous) ;
 *   2. `req.query.page` / `req.query.limit` réécrits avec les valeurs bornées —
 *      ce qui protège IMMÉDIATEMENT tous les services existants, qui continuent
 *      de lire `req.query`, sans qu'aucun d'eux n'ait à être modifié.
 * Les autres paramètres de requête (`search`, `statut`, `type`, `role`…) sont
 * intégralement préservés : le middleware ne réécrit que `page` et `limit`.
 *
 * Migration côté services (à appliquer par le propriétaire de `service/`) :
 *   remplacer `{ page = 1, limit = 20 }` par la lecture de `req.pagination`
 *   transmise explicitement par le contrôleur — voir le rapport de correctifs.
 */

// Plafond dur : au-delà, la requête n'est plus une consultation mais un dump.
const LIMITE_MAX = 100;
const LIMITE_DEFAUT = 20;

// Plafond de page : `offset = (page - 1) * limit` — sans borne, `?page=1e9`
// produit un OFFSET astronomique que PostgreSQL évalue en scannant la table.
const PAGE_MAX = 5000;

/**
 * Convertit une valeur de query string en entier borné.
 * Tolère les tableaux (`?limit=1&limit=2` → dernière valeur), les valeurs
 * absentes, non numériques, négatives, flottantes ou `Infinity`.
 */
function entierBorne(valeur, min, max, defaut) {
  const brut = Array.isArray(valeur) ? valeur[valeur.length - 1] : valeur;
  if (brut === undefined || brut === null || brut === '') return defaut;

  const nombre = Number(brut);
  if (!Number.isFinite(nombre)) return defaut;

  const entier = Math.trunc(nombre);
  if (entier < min) return min;
  if (entier > max) return max;
  return entier;
}

/**
 * @param {{ max?: number, defaut?: number }} [options]
 *   max    — plafond spécifique à la route (ne peut jamais dépasser LIMITE_MAX)
 *   defaut — taille de page par défaut si le client n'en fournit pas
 */
const paginate = ({ max = LIMITE_MAX, defaut = LIMITE_DEFAUT } = {}) => {
  const plafond = Math.min(max, LIMITE_MAX);
  const parDefaut = Math.min(defaut, plafond);

  return (req, res, next) => {
    // Une seule lecture du getter : les suivantes retourneraient un autre objet.
    const brut = req.query || {};

    const page = entierBorne(brut.page, 1, PAGE_MAX, 1);
    const limit = entierBorne(brut.limit, 1, plafond, parDefaut);

    req.pagination = { page, limit, offset: (page - 1) * limit };

    // Propriété PROPRE sur `req` : masque le getter du prototype `app.request`.
    // `writable`/`configurable` restent à true pour ne bloquer aucun middleware
    // en aval qui voudrait retoucher la query.
    Object.defineProperty(req, 'query', {
      value: { ...brut, page, limit },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    next();
  };
};

module.exports = paginate;
module.exports.LIMITE_MAX = LIMITE_MAX;
module.exports.LIMITE_DEFAUT = LIMITE_DEFAUT;
module.exports.PAGE_MAX = PAGE_MAX;
