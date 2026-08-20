const Joi = require('joi');

const telephone = Joi.string()
  .pattern(/^\+?[0-9\s\-\.]{7,20}$/)
  .message('{{#label}} doit être un numéro de téléphone valide');

const motDePasse = Joi.string()
  .min(8)
  .max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .message('{{#label}} doit contenir au moins 8 caractères, une majuscule, une minuscule et un chiffre');

const nom = Joi.string().trim().min(2).max(50);
const prenom = Joi.string().trim().min(2).max(50);
const email = Joi.string().trim().email().lowercase();
const adresse = Joi.string().trim().max(200);

// UUID v4
const uuid = Joi.string().guid({ version: 'uuidv4' });

// Rôles métier (cahier des charges, section Acteurs)
const ROLE_UTILISATEUR = ['Admin', 'ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise', 'Client', 'MaitreOuvrage', 'MaitreOeuvre', 'Pilote', 'SousTraitant'];
const role = Joi.string().valid(...ROLE_UTILISATEUR);

// Statuts
const STATUT_RESERVE = ['creee', 'affectee', 'prise_en_charge', 'en_cours', 'corrigee', 'a_verifier', 'validee', 'refusee', 'rouverte', 'en_retard', 'cloturee'];
const STATUT_CHANTIER = ['en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture'];
const SEVERITE_PRIORITE = ['faible', 'moyenne', 'haute', 'critique'];

// Couleur CSS STRICTE — hexadécimal uniquement (#rgb, #rrggbb, #rrggbbaa).
//
// CAUSE DU CORRECTIF : plusieurs schémas laissaient passer une couleur en
// chaîne libre. Ces valeurs sont réinjectées telles quelles dans une propriété
// CSS côté admin ; une chaîne comme `url("http://attaquant/x")` y devient une
// REQUÊTE SORTANTE émise au simple chargement du plan (fuite d'adresse IP et
// signal de consultation vers un tiers), et `expression(...)` / `javascript:`
// ouvrent d'autres variantes sur les moteurs permissifs.
// Une liste blanche de format ferme la catégorie entière : aucune fonction CSS,
// aucun mot-clé, aucune URL ne peut satisfaire ce motif.
const couleurHex = Joi.string()
  .trim()
  .pattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
  .message('{{#label}} doit être une couleur hexadécimale (ex: #1d4ed8)');

// URL http(s) uniquement — interdit javascript:, data:, file:, vbscript:…
const urlHttp = Joi.string().trim().max(2000).uri({ scheme: ['http', 'https'] });

// Pagination query params (GET lists)
// IMPORTANT : le middleware validate() applique stripUnknown: true, donc
// .unknown(true) seul ne suffit pas à préserver les query params — il faut
// les déclarer explicitement ici, sinon ils sont silencieusement supprimés.
//
// ⚠️ Ce schéma N'EST PAS le mécanisme de plafonnement effectif. Sous Express 5,
// `req.query` est un getter non mémoïsé : `validate(paginationQuery, 'query')`
// mute un objet jeté et ne borne donc rien. Le plafond réel est appliqué par
// `src/middlewares/pagination.middleware.js`, monté sur les routes de liste.
// Ce schéma reste utile pour valider une pagination transmise dans un `body`.
const paginationQuery = Joi.object({
  page:   Joi.number().integer().min(1).default(1),
  limit:  Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().max(200).allow('').optional(),
}).unknown(true); // tolère d'autres query params ignorés

module.exports = {
  telephone, motDePasse, nom, prenom, email, adresse, uuid, role,
  ROLE_UTILISATEUR, STATUT_RESERVE, STATUT_CHANTIER, SEVERITE_PRIORITE,
  paginationQuery, couleurHex, urlHttp,
};
