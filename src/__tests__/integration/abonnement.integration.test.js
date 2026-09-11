'use strict';

/**
 * Test d'INTÉGRATION — concurrence réelle sur PostgreSQL.
 *
 * Ignoré tant que `INTEGRITE_DB_NAME` n'est pas défini : il exige une base
 * JETABLE, déjà migrée (jamais la base de développement). Lancement :
 *
 *   INTEGRITE_DB_HOST=127.0.0.1 INTEGRITE_DB_PORT=55432 INTEGRITE_DB_USER=audit \
 *   INTEGRITE_DB_NAME=suivie_chantier_audit npx jest src/__tests__/integration --runInBand
 *
 * Ce qu'il démontre, et qu'aucun test à base de doublures ne peut démontrer :
 *  - deux paiements activés EN MÊME TEMPS laissent exactement UNE
 *    souscription active (verrou de l'organisation + index unique partiel) ;
 *  - l'index rend l'état « deux actives » impossible même par un INSERT direct ;
 *  - le même webhook rejoué en parallèle n'active qu'une fois.
 */

const ACTIF = Boolean(process.env.INTEGRITE_DB_NAME);
const decrire = ACTIF ? describe : describe.skip;

if (ACTIF) {
  process.env.DB_HOST = process.env.INTEGRITE_DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.INTEGRITE_DB_PORT || '5432';
  process.env.DB_USER = process.env.INTEGRITE_DB_USER || 'audit';
  process.env.DB_PASSWORD = process.env.INTEGRITE_DB_PASSWORD || '';
  process.env.DB_NAME = process.env.INTEGRITE_DB_NAME;
}

jest.mock('../../modules/subscription/service/recuPaiement.service.js', () => ({ emettre: jest.fn() }));

decrire('abonnements — concurrence réelle (PostgreSQL)', () => {
  const { randomUUID } = require('crypto');
  const sequelize = require('../../config/db.js');
  const { Organisation, PlanAbonnement, AbonnementSouscrit } = require('../../models/index.js');
  const SubscriptionService = require('../../modules/subscription/service/subscription.service.js');

  let plan;

  beforeAll(async () => {
    plan = await PlanAbonnement.findOne({ where: { code: 'pro' } })
      || await PlanAbonnement.create({ code: `pro-${Date.now()}`, nom: 'Pro test', prix: 89, devise: 'EUR', periode: 'mois', actif: true });
  });

  afterAll(async () => { await sequelize.close(); });

  const nouvelleOrganisation = () => Organisation.create({
    nom: `Org intégrité ${randomUUID().slice(0, 8)}`, trial_ends_at: null, is_subscribed: false,
  });

  const enAttente = (organisationId, reference) => AbonnementSouscrit.create({
    organisationId, planAbonnementId: plan.id, plan_code: plan.code, plan_nom: plan.nom,
    prix_paye: plan.prix, devise: plan.devise, periode: 'mois', statut: 'en_attente',
    fournisseur: 'stripe', reference_paiement: reference,
  });

  it('deux paiements activés simultanément → exactement UNE souscription active', async () => {
    const org = await nouvelleOrganisation();
    await enAttente(org.id, `pi_${randomUUID()}`);
    await enAttente(org.id, `pi_${randomUUID()}`);
    const refs = (await AbonnementSouscrit.findAll({ where: { organisationId: org.id } })).map((s) => s.reference_paiement);

    await Promise.all(refs.map((r) => SubscriptionService._activerDepuisPaiement(r, null)));

    const actives = await AbonnementSouscrit.count({ where: { organisationId: org.id, statut: 'active' } });
    expect(actives).toBe(1);
    await org.reload();
    expect(org.is_subscribed).toBe(true);
  });

  it('le même webhook rejoué 5 fois en parallèle n’active qu’une fois', async () => {
    const org = await nouvelleOrganisation();
    const reference = `pi_${randomUUID()}`;
    await enAttente(org.id, reference);

    await Promise.all(Array.from({ length: 5 }, () => SubscriptionService._activerDepuisPaiement(reference, null)));

    const lignes = await AbonnementSouscrit.findAll({ where: { organisationId: org.id } });
    expect(lignes.filter((l) => l.statut === 'active')).toHaveLength(1);
    expect(lignes).toHaveLength(1);
  });

  it('PayTech et activation manuelle en parallèle → une seule active', async () => {
    const org = await nouvelleOrganisation();
    await Promise.all([
      SubscriptionService.enregistrerPaiementExterne({ organisationId: org.id, planId: plan.code, reference: `ref_${randomUUID()}` }),
      SubscriptionService.activerManuellement(org.id, { planId: plan.code }, null),
      SubscriptionService.enregistrerPaiementExterne({ organisationId: org.id, planId: plan.code, reference: `ref_${randomUUID()}` }),
    ]);

    expect(await AbonnementSouscrit.count({ where: { organisationId: org.id, statut: 'active' } })).toBe(1);
  });

  it('la base REFUSE une seconde souscription active, même par un INSERT direct', async () => {
    const org = await nouvelleOrganisation();
    await SubscriptionService.activerManuellement(org.id, { planId: plan.code }, null);

    await expect(AbonnementSouscrit.create({
      organisationId: org.id, planAbonnementId: plan.id, plan_code: plan.code, plan_nom: plan.nom,
      prix_paye: 1, devise: 'EUR', periode: 'mois', statut: 'active', date_debut: new Date(),
      date_fin: new Date(Date.now() + 86_400_000), fournisseur: 'manuel',
    })).rejects.toThrow();
  });

  it('la base REFUSE un prix payé négatif', async () => {
    const org = await nouvelleOrganisation();
    await expect(AbonnementSouscrit.create({
      organisationId: org.id, planAbonnementId: plan.id, plan_code: plan.code, plan_nom: plan.nom,
      prix_paye: -5, devise: 'EUR', periode: 'mois', statut: 'en_attente', fournisseur: 'stripe',
      reference_paiement: `pi_${randomUUID()}`,
    })).rejects.toThrow();
  });
});
