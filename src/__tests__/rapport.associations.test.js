'use strict';

/**
 * Tests — les associations dont dépend la génération de rapport.
 *
 * ## Le défaut d'origine
 *
 * « User is not associated to ChantierMembre! » : le rapport liste les
 * participants en partant de `ChantierMembre` avec un include `utilisateur`,
 * mais seul le `belongsToMany` Chantier ↔ Utilisateur était déclaré. Aucun
 * rapport ne sortait, sur aucun chantier.
 *
 * `rapport.diagnostic.test.js` remplace les modèles par des doublures : il ne
 * pouvait pas le voir. Ici on charge les VRAIS modèles et on laisse Sequelize
 * valider les includes ; seule la requête SQL finale est interceptée, aucune
 * base n'est nécessaire.
 */

const sequelize = require('../config/db.js');
const {
  ChantierMembre, Utilisateur, Reserve, Batiment, Etage, Zone, Plan, Lot,
  Partenaire, Organisation, CorpsEtat, Phase, Media, ReservePosition, ReserveHistorique,
  Rapport, RapportFiltre, RapportDestinataire, RapportHistorique, RapportPartage, Chantier,
} = require('../models/index.js');

beforeEach(() => {
  jest.spyOn(sequelize, 'query').mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => sequelize.close());

test('ChantierMembre → utilisateur : l’include des participants est accepté', async () => {
  await expect(ChantierMembre.findAll({
    where: { chantierId: '22222222-2222-4222-8222-222222222222' },
    include: [{
      model: Utilisateur, as: 'utilisateur', required: true,
      attributes: ['id', 'nom', 'prenom', 'email', 'telephone', 'fonction', 'role'],
    }],
  })).resolves.toEqual([]);
});

test('Reserve : tous les includes du rapport sont déclarés', async () => {
  await expect(Reserve.findAll({
    where: { chantierId: '22222222-2222-4222-8222-222222222222' },
    include: [
      { model: Batiment, as: 'batiment', required: false },
      { model: Etage, as: 'etage', required: false },
      { model: Zone, as: 'zone', required: false },
      { model: Plan, as: 'plan', required: false },
      { model: Lot, as: 'lot', required: false },
      { model: Partenaire, as: 'partenaire', required: false },
      { model: Organisation, as: 'entreprise', required: false },
      { model: CorpsEtat, as: 'corpsEtat', required: false },
      { model: Phase, as: 'phase', required: false },
      { model: Media, as: 'medias', required: false },
    ],
  })).resolves.toEqual([]);
});

// ── Module Rapports du cahier des charges ──────────────────────────────────

test('Reserve : les includes du service Rapports (position, validateur, créateur)', async () => {
  await expect(Reserve.findAll({
    where: { chantierId: '22222222-2222-4222-8222-222222222222' },
    include: [
      { model: ReservePosition, as: 'position', required: false },
      { model: Utilisateur, as: 'validateur', required: false },
      { model: Utilisateur, as: 'createur', required: false },
    ],
  })).resolves.toEqual([]);
});

test('Batiment → étages → zones : la structure lue pour résoudre « R+3 »', async () => {
  await expect(Batiment.findAll({
    where: { chantierId: '22222222-2222-4222-8222-222222222222' },
    include: [{ model: Etage, as: 'etages', include: [{ model: Zone, as: 'zones' }] }],
  })).resolves.toEqual([]);
});

test('ReserveHistorique → utilisateur : les faits du rapport de levée', async () => {
  await expect(ReserveHistorique.findAll({
    include: [{ model: Utilisateur, as: 'utilisateur', required: false }],
  })).resolves.toEqual([]);
});

test('Rapport : filtres, destinataires, historique, partages, entreprise, versions', async () => {
  await expect(Rapport.findAll({
    include: [
      { model: Chantier, as: 'chantier', required: true, include: [{ model: Organisation, as: 'organisation' }] },
      { model: RapportFiltre, as: 'filtresLignes', required: false },
      { model: RapportDestinataire, as: 'destinataires', required: false },
      { model: RapportHistorique, as: 'historiques', required: false },
      { model: RapportPartage, as: 'partages', required: false },
      { model: Partenaire, as: 'entrepriseCible', required: false },
      { model: Utilisateur, as: 'generateur', required: false },
      { model: Rapport, as: 'versionPrecedente', required: false },
    ],
  })).resolves.toEqual([]);
});

test('historique et partages : leurs auteurs', async () => {
  await expect(RapportHistorique.findAll({
    include: [{ model: Utilisateur, as: 'acteur', required: false }],
  })).resolves.toEqual([]);
  await expect(RapportPartage.findAll({
    include: [
      { model: Utilisateur, as: 'createur', required: false },
      { model: Rapport, as: 'rapport', required: true, include: [{ model: Chantier, as: 'chantier' }] },
    ],
  })).resolves.toEqual([]);
});
