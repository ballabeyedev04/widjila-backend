'use strict';

/**
 * Tests d'INTÉGRATION métier — PostgreSQL réel (base JETABLE, déjà migrée).
 * Ignorés sans `INTEGRITE_DB_NAME` — voir abonnement.integration.test.js.
 *
 * Chaque test force l'incohérence que le correctif empêche, puis vérifie
 * l'état FINAL en base (pas seulement la réponse du service).
 */

const { randomUUID, randomBytes } = require('crypto');
const { configurerBaseIntegration, fabriquer, nouvelUtilisateur, nouvelleReserve, decalerJour } = require('./_fabrique.js');

const ACTIF = configurerBaseIntegration();
const decrire = ACTIF ? describe : describe.skip;

jest.mock('../../infrastructure/emailService.js', () => new Proxy({}, { get: () => jest.fn(async () => null) }));
jest.mock('../../infrastructure/storage.service.js', () => {
  let n = 0;
  return {
    storeFile: jest.fn(async (_b, _nom, dossier) => { n += 1; return `/uploads/${dossier}/integration-${Date.now()}-${n}.pdf`; }),
    deleteFile: jest.fn(async () => {}),
    ouvrirFichier: jest.fn(async () => null),
    urlTemporaire: jest.fn(async () => null),
    ensureUploadDir: jest.fn(),
    estPublic: jest.fn(() => false),
  };
});

decrire('intégrité métier — PostgreSQL réel', () => {
  const sequelize = require('../../config/db.js');
  const models = require('../../models/index.js');
  const { Reserve, ReserveHistorique, Chantier, Plan, Batiment } = models;
  const ChantierService = require('../../modules/chantier/service/chantier.service.js');
  const PlanService = require('../../modules/plan/service/plan.service.js');
  const { marquerReservesEnRetard, aujourdhui } = require('../../jobs/markReservesEnRetard.job.js');

  afterAll(async () => { await sequelize.close(); });

  const fichier = { buffer: Buffer.from('%PDF-1.4'), originalname: 'plan.pdf' };

  // ── Tâche « en retard » ────────────────────────────────────────────────
  describe('marquage des réserves en retard', () => {
    it('ne marque que le travail NON déclaré fait, historise, et se rejoue sans effet', async () => {
      const { chantier, utilisateur } = await fabriquer(models);
      const hier = decalerJour(aujourdhui(), -1);
      const jour = aujourdhui();

      const aFaire = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'en_cours', date_limite: hier });
      const corrigee = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'corrigee', date_limite: hier });
      const aVerifier = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'a_verifier', date_limite: hier });
      const dueAujourdhui = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'affectee', date_limite: jour });
      const validee = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'validee', date_limite: hier });

      await marquerReservesEnRetard();

      const statut = async (r) => (await Reserve.findByPk(r.id)).statut;
      expect(await statut(aFaire)).toBe('en_retard');
      expect(await statut(corrigee)).toBe('corrigee');     // travail rendu : jamais écrasé
      expect(await statut(aVerifier)).toBe('a_verifier');
      expect(await statut(dueAujourdhui)).toBe('affectee'); // pas encore dépassée
      expect(await statut(validee)).toBe('validee');

      const histo = await ReserveHistorique.findAll({ where: { reserveId: aFaire.id, action: 'statut' } });
      expect(histo).toHaveLength(1);
      expect(histo[0].anciennes_valeurs).toEqual({ statut: 'en_cours' });

      // Rejeu (rattrapage au démarrage, reprise sur erreur) : rien de plus.
      await marquerReservesEnRetard();
      expect(await ReserveHistorique.count({ where: { reserveId: aFaire.id, action: 'statut' } })).toBe(1);
    });
  });

  // ── Circuit de validation des chantiers ────────────────────────────────
  describe('validation de chantier concurrente', () => {
    /** Une demande de chantier avec un plan joint, et deux valideurs. */
    async function demandeAvecPlan() {
      const { organisation, utilisateur: demandeur } = await fabriquer(models, { role: 'Entreprise' });
      const chantier = await Chantier.create({
        organisationId: organisation.id, code: `CH-D-${randomUUID().slice(0, 8)}`, nom: 'Demande',
        statut: 'en_attente_validation', demandeurId: demandeur.id,
      });
      await Plan.create({
        chantierId: chantier.id, nom: 'Plan joint', version: 1, fichier_url: `/uploads/plans/j-${randomUUID()}.pdf`,
        statut: 'en_attente_validation', is_current: true,
      });
      const chef = await nouvelUtilisateur(models, organisation.id, 'ChefProjet');
      const moa = await nouvelUtilisateur(models, organisation.id, 'MaitreOuvrage');
      return { chantier, chef, moa };
    }

    it('valider ET rejeter en même temps (×6) → jamais « rejeté » avec des plans ouverts', async () => {
      // Un rejet peut être révisé par une validation (STATUT_CHANTIER_EN_DEMANDE),
      // l'inverse non. Sous verrou, les deux ordres possibles donnent :
      //   validation d'abord → le rejet est refusé ;
      //   rejet d'abord      → la validation le révise (deux succès).
      // Sans verrou, on obtenait « rejete » + plans « actif » + deux courriels.
      for (let i = 0; i < 6; i += 1) {
        const { chantier, chef, moa } = await demandeAvecPlan();

        const [v, r] = await Promise.all([
          ChantierService.validerChantier(chantier.id, chef),
          ChantierService.rejeterChantier(chantier.id, moa, 'Pièces manquantes pour ce dossier'),
        ]);

        await chantier.reload();
        const plan = await Plan.findOne({ where: { chantierId: chantier.id } });
        if (chantier.statut === 'en_preparation') {
          expect(v.success).toBe(true);
          expect(plan.statut).toBe('actif');
        } else {
          expect(chantier.statut).toBe('rejete');
          expect(v.success).toBe(false);
          expect(r.success).toBe(true);
          expect(plan.statut).toBe('en_attente_validation');
        }
      }
    });

    it('deux validations simultanées : une seule passe, un seul rattachement', async () => {
      const { chantier, chef, moa } = await demandeAvecPlan();

      const res = await Promise.all([
        ChantierService.validerChantier(chantier.id, chef),
        ChantierService.validerChantier(chantier.id, moa),
      ]);

      expect(res.filter((x) => x.success)).toHaveLength(1);
      expect(await models.ChantierMembre.count({ where: { chantierId: chantier.id } })).toBe(1);
    });

    it('un rattachement du demandeur en erreur SQL n’avorte PAS la validation (savepoint)', async () => {
      const { chantier, chef } = await demandeAvecPlan();
      // Une vraie erreur PostgreSQL DANS la transaction : sans savepoint, la
      // transaction est avortée et la mise à jour des plans échoue derrière.
      const espion = jest.spyOn(models.ChantierMembre, 'findOrCreate')
        .mockImplementation(({ transaction }) => sequelize.query('SELECT 1/0', { transaction }));
      let r;
      try {
        r = await ChantierService.validerChantier(chantier.id, chef);
      } finally {
        espion.mockRestore();
      }

      expect(r.success).toBe(true);
      await chantier.reload();
      expect(chantier.statut).toBe('en_preparation');
      expect((await Plan.findOne({ where: { chantierId: chantier.id } })).statut).toBe('actif');
    });

    it('clôture refusée tant qu’une réserve est ouverte ; plus aucune réserve sur un chantier clôturé', async () => {
      const { organisation, chantier, utilisateur } = await fabriquer(models);
      await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'en_cours' });

      const refus = await ChantierService.changerStatut(organisation.id, chantier.id, 'cloture');
      expect(refus.success).toBe(false);

      await Reserve.update({ statut: 'validee' }, { where: { chantierId: chantier.id } });
      const ok = await ChantierService.changerStatut(organisation.id, chantier.id, 'cloture');
      expect(ok.success).toBe(true);

      const ReserveService = require('../../modules/reserve/service/reserve.service.js');
      const creation = await ReserveService.creerReserve(organisation.id, { chantierId: chantier.id, titre: 'Après clôture' }, utilisateur.id);
      expect(creation.success).toBe(false);
      expect(await Reserve.count({ where: { chantierId: chantier.id, statut: { [require('sequelize').Op.notIn]: ['validee', 'cloturee'] } } })).toBe(0);
    });
  });

  // ── Plans : lignées, sous-plans, suppression ───────────────────────────
  describe('plans — lignées de versions', () => {
    it('deux plans homonymes à deux emplacements restent TOUS DEUX courants et visibles', async () => {
      const { organisation, chantier } = await fabriquer(models);
      const batA = await Batiment.create({ chantierId: chantier.id, nom: 'A' });
      const batB = await Batiment.create({ chantierId: chantier.id, nom: 'B' });

      await PlanService.upload(organisation.id, chantier.id, { nom: 'Plan niveau', batimentId: batA.id }, fichier);
      await PlanService.upload(organisation.id, chantier.id, { nom: 'Plan niveau', batimentId: batB.id }, fichier);

      const courants = await Plan.findAll({ where: { chantierId: chantier.id, nom: 'Plan niveau', is_current: true } });
      expect(courants).toHaveLength(2);
      const { plans } = await PlanService.listPlansRacines(organisation.id, chantier.id);
      expect(plans.filter((p) => p.nom === 'Plan niveau')).toHaveLength(2);
    });

    it('une nouvelle version du parent emmène ses sous-plans', async () => {
      const { organisation, chantier } = await fabriquer(models);
      const { plan: parent } = await PlanService.upload(organisation.id, chantier.id, { nom: 'Global' }, fichier);
      const { plan: enfant } = await PlanService.upload(organisation.id, chantier.id, { nom: 'Détail', parentId: parent.id }, fichier);

      const { plan: parentV2 } = await PlanService.upload(organisation.id, chantier.id, { nom: 'Global' }, fichier);

      await enfant.reload();
      expect(enfant.parentId).toBe(parentV2.id);
      const { sousPlans } = await PlanService.listSousPlans(organisation.id, parentV2.id);
      expect(sousPlans.map((p) => p.id)).toContain(enfant.id);
    });

    it('supprimer la version courante rend le drapeau à la précédente ; un plan porteur ne se supprime pas', async () => {
      const { organisation, chantier, utilisateur } = await fabriquer(models);
      const { plan: v1 } = await PlanService.upload(organisation.id, chantier.id, { nom: 'Coupe' }, fichier);
      const { plan: v2 } = await PlanService.upload(organisation.id, chantier.id, { nom: 'Coupe' }, fichier);

      await nouvelleReserve(models, chantier, utilisateur.id, { planId: v2.id });
      const refus = await PlanService.supprimerPlan(organisation.id, v2.id);
      expect(refus.success).toBe(false);

      await Reserve.destroy({ where: { planId: v2.id }, force: true });
      const ok = await PlanService.supprimerPlan(organisation.id, v2.id);
      expect(ok.success).toBe(true);
      await v1.reload();
      expect(v1.is_current).toBe(true);
    });
  });

  // ── Rafales concurrentes (chaos) ───────────────────────────────────────
  describe('concurrence — numérotation et versions', () => {
    it('12 créations de réserve simultanées : 12 numéros distincts', async () => {
      const ReserveService = require('../../modules/reserve/service/reserve.service.js');
      const { organisation, chantier, utilisateur } = await fabriquer(models);

      const res = await Promise.all(Array.from({ length: 12 }, (_, i) => ReserveService.creerReserve(
        organisation.id, { chantierId: chantier.id, titre: `Concurrente ${i}` }, utilisateur.id
      )));

      expect(res.filter((r) => !r.success).map((r) => r.message)).toEqual([]);
      const numeros = (await Reserve.findAll({ where: { chantierId: chantier.id } })).map((r) => r.numero);
      expect(numeros).toHaveLength(12);
      expect(new Set(numeros).size).toBe(12);
    });

    it('6 dépôts simultanés du même plan : 6 versions distinctes, UNE seule courante', async () => {
      const { organisation, chantier } = await fabriquer(models);

      const res = await Promise.all(Array.from({ length: 6 }, () => PlanService.upload(
        organisation.id, chantier.id, { nom: 'Façade' }, fichier
      )));

      expect(res.every((r) => r.success)).toBe(true);
      const plans = await Plan.findAll({ where: { chantierId: chantier.id, nom: 'Façade' } });
      expect(new Set(plans.map((p) => p.version)).size).toBe(6);
      expect(plans.filter((p) => p.is_current)).toHaveLength(1);
    });
  });

  // ── Plafond d'utilisateurs de la formule ───────────────────────────────
  describe('plafond d’utilisateurs — ajouts simultanés', () => {
    it('limite 2 (1 déjà actif) : 3 ajouts simultanés → UN seul passe, jamais 3 actifs', async () => {
      const OrganisationService = require('../../modules/organisation/service/organisation.service.js');
      const { organisation, utilisateur: chef } = await fabriquer(models);
      const code = `sieges-${randomUUID().slice(0, 8)}`;
      const formule = await models.PlanAbonnement.create({
        code, nom: 'Deux sièges', prix: 10, devise: 'EUR', periode: 'mois', actif: true, limite_utilisateurs: 2,
      });
      await models.AbonnementSouscrit.create({
        organisationId: organisation.id, planAbonnementId: formule.id, plan_code: code, plan_nom: formule.nom,
        prix_paye: 10, devise: 'EUR', periode: 'mois', statut: 'active', fournisseur: 'stripe',
        reference_paiement: `pi_${randomUUID()}`, date_debut: new Date(), date_fin: new Date(Date.now() + 30 * 86400000),
      });
      const auteur = { id: chef.id, role: 'ChefProjet', prenom: 'Chef', nom: 'Test' };

      const res = await Promise.all(Array.from({ length: 3 }, (_, i) => OrganisationService.ajouterMembre(
        organisation.id,
        { nom: `Membre${i}`, prenom: 'Test', email: `m${i}-${randomUUID().slice(0, 8)}@exemple.test`, role: 'ConducteurTravaux' },
        auteur
      )));

      expect(res.filter((r) => r.success)).toHaveLength(1);
      expect(await models.Utilisateur.count({ where: { organisationId: organisation.id, statut: 'actif' } })).toBe(2);
    });
  });

  // ── Demandes d'inscription : deux administrateurs ──────────────────────
  describe('demande d’inscription tranchée par deux administrateurs', () => {
    it('valider ET rejeter en même temps (×4) : un seul verdict, cohérent avec l’essai', async () => {
      const DemandeInscriptionService = require('../../modules/admin/service/demandeInscription.service.js');
      const admin = await models.Utilisateur.create({
        organisationId: null, nom: 'Admin', prenom: 'Plateforme', email: `admin-${randomUUID().slice(0, 8)}@exemple.test`,
        mot_de_passe: 'hash-factice', role: 'Admin', statut: 'actif',
      });

      for (let i = 0; i < 4; i += 1) {
        const { organisation, utilisateur } = await fabriquer(models, { role: 'Entreprise' });
        await utilisateur.update({ statut: 'en_attente_validation' });

        const [v, r] = await Promise.all([
          DemandeInscriptionService.valider(utilisateur.id, {}, admin, '127.0.0.1'),
          DemandeInscriptionService.rejeter(utilisateur.id, { motif: 'Dossier incomplet' }, admin, '127.0.0.1'),
        ]);

        expect([v.success, r.success].filter(Boolean)).toHaveLength(1);
        await utilisateur.reload();
        await organisation.reload();
        if (v.success) {
          expect(utilisateur.statut).toBe('actif');
          expect(organisation.trial_ends_at).not.toBeNull();
        } else {
          expect(utilisateur.statut).toBe('rejete');
          expect(organisation.trial_ends_at).toBeNull();
        }
      }
    });
  });

  // ── Réconciliation ─────────────────────────────────────────────────────
  describe('script de réconciliation (invariants)', () => {
    it('toutes les requêtes tournent sur le schéma réel, et un écart forcé est détecté puis disparaît', async () => {
      const { verifierInvariants } = require('../../../scripts/verifierIntegrite.js');
      const { chantier, utilisateur } = await fabriquer(models, { statutChantier: 'cloture' });
      // Écriture DIRECTE, hors service : c'est ce que le script doit rattraper.
      const ouverte = await nouvelleReserve(models, chantier, utilisateur.id, { statut: 'en_cours' });

      const avant = await verifierInvariants(sequelize, { echantillon: 100000 });
      expect(avant.filter((i) => i.erreur)).toEqual([]);
      expect(avant.find((i) => i.code === 'RES-1').exemples).toContain(ouverte.id);

      await ouverte.destroy();
      const apres = await verifierInvariants(sequelize, { echantillon: 100000 });
      expect(apres.find((i) => i.code === 'RES-1').exemples).not.toContain(ouverte.id);
    });
  });

  // ── Purge RGPD des comptes supprimés ───────────────────────────────────
  describe('purge des comptes supprimés', () => {
    it('efface les comptes sans pièce, garde les auteurs de réserves — sans échouer', async () => {
      const { purgerDonneesPersonnelles } = require('../../jobs/purgeDonneesPersonnelles.job.js');
      const { organisation, chantier } = await fabriquer(models);
      const auteur = await nouvelUtilisateur(models, organisation.id, 'ChefProjet');
      const libre = await nouvelUtilisateur(models, organisation.id, 'ChefProjet');
      const reserve = await nouvelleReserve(models, chantier, auteur.id);
      // Jeton révoqué laissé par la pseudonymisation : il bloquait lui aussi.
      for (const u of [auteur, libre]) {
        await models.RefreshToken.create({
          tokenHash: randomBytes(32).toString('hex'), utilisateurId: u.id,
          expiresAt: new Date(Date.now() + 86400000), revoked: true,
        });
      }
      await auteur.destroy();
      await libre.destroy();
      await sequelize.query(
        "UPDATE utilisateur SET deleted_at = now() - interval '400 days' WHERE id IN (:ids)",
        { replacements: { ids: [auteur.id, libre.id] } }
      );

      // REPRODUCTION de l'ancien comportement : un DELETE sec sur le compte
      // auteur est refusé par la clé étrangère — c'est ce qui faisait
      // échouer toute la purge, chaque semaine.
      await expect(models.Utilisateur.destroy({ where: { id: auteur.id }, force: true }))
        .rejects.toThrow(/foreign key|clé étrangère/i);

      const bilan = await purgerDonneesPersonnelles();

      expect(bilan.comptesEffacesDefinitivement).toBeGreaterThanOrEqual(1);
      expect(await models.Utilisateur.findByPk(libre.id, { paranoid: false })).toBeNull();
      expect(await models.RefreshToken.count({ where: { utilisateurId: libre.id } })).toBe(0);
      // L'auteur reste (pseudonymisé à la suppression) : la réserve garde son constat.
      expect(await models.Utilisateur.findByPk(auteur.id, { paranoid: false })).not.toBeNull();
      expect(await Reserve.findByPk(reserve.id)).not.toBeNull();

      // Rejeu : rien de plus à faire, et toujours aucune erreur.
      await expect(purgerDonneesPersonnelles()).resolves.toBeDefined();
    });
  });
});
