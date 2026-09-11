'use strict';

/**
 * Données de départ des tests d'intégration (base JETABLE uniquement).
 * Chaque appel crée une organisation isolée : les tests ne se marchent pas
 * dessus, même rejoués sur la même base.
 */

const { randomUUID } = require('crypto');

function configurerBaseIntegration() {
  if (!process.env.INTEGRITE_DB_NAME) return false;
  process.env.DB_HOST = process.env.INTEGRITE_DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.INTEGRITE_DB_PORT || '5432';
  process.env.DB_USER = process.env.INTEGRITE_DB_USER || 'audit';
  process.env.DB_PASSWORD = process.env.INTEGRITE_DB_PASSWORD || '';
  process.env.DB_NAME = process.env.INTEGRITE_DB_NAME;
  // Aucun service externe réel pendant ces tests (courriel, stockage, push).
  process.env.R2_ACCOUNT_ID = '';
  process.env.RESEND_API_KEY = '';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
  return true;
}

async function fabriquer(models, { statutChantier = 'en_cours', role = 'ChefProjet' } = {}) {
  const { Organisation, Utilisateur, Chantier } = models;
  const id = randomUUID().slice(0, 8);
  const organisation = await Organisation.create({ nom: `Org ${id}`, trial_ends_at: null });
  const utilisateur = await Utilisateur.create({
    organisationId: organisation.id, nom: 'Test', prenom: 'Integration',
    email: `u-${id}@exemple.test`, mot_de_passe: 'hash-factice', role, statut: 'actif',
  });
  const chantier = await Chantier.create({
    organisationId: organisation.id, code: `CH-${id}`, nom: `Chantier ${id}`, statut: statutChantier,
  });
  return { organisation, utilisateur, chantier, id };
}

async function nouvelUtilisateur(models, organisationId, role) {
  const id = randomUUID().slice(0, 8);
  return models.Utilisateur.create({
    organisationId, nom: role, prenom: 'Test', email: `${role}-${id}@exemple.test`,
    mot_de_passe: 'hash-factice', role, statut: 'actif',
  });
}

let compteurNumero = 0;
async function nouvelleReserve(models, chantier, creePar, extra = {}) {
  compteurNumero += 1;
  return models.Reserve.create({
    chantierId: chantier.id,
    numero: `T-${Date.now()}-${compteurNumero}`,
    titre: `Réserve ${compteurNumero}`,
    creePar,
    ...extra,
  });
}

/** Date AAAA-MM-JJ décalée de `jours` par rapport à `base` (AAAA-MM-JJ). */
function decalerJour(base, jours) {
  const [a, m, j] = base.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j + jours));
  return d.toISOString().slice(0, 10);
}

module.exports = { configurerBaseIntegration, fabriquer, nouvelUtilisateur, nouvelleReserve, decalerJour };
