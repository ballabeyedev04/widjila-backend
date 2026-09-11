'use strict';

/**
 * Tests — délai moyen de traitement (dashboard, module 9).
 *
 * ## Le défaut d'origine
 *
 * Le filtre chantier était posé sur `ReserveHistorique`, qui n'a PAS de
 * colonne `chantier_id`. PostgreSQL rejetait la requête (colonne inconnue) :
 * la route `/chantiers/:id/duree-traitement` et le tableau de bord qui s'en
 * sert échouaient à chaque appel.
 *
 * Les vrais modèles sont chargés ; seule l'exécution SQL est interceptée, pour
 * lire la requête que Sequelize génère réellement.
 */

const sequelize = require('../config/db.js');
const DashboardService = require('../modules/dashboard/service/dashboard.service.js');

let requetes;

beforeEach(() => {
  requetes = [];
  jest.spyOn(sequelize, 'query').mockImplementation(async (sql) => {
    requetes.push(String(sql));
    return [];
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => sequelize.close());

test('le chantier est filtré sur la réserve jointe, pas sur l’historique', async () => {
  const r = await DashboardService.dureeTraitement('11111111-1111-4111-8111-111111111111');

  expect(r.success).toBe(true);
  const historiques = requetes.filter((sql) => sql.includes('reserve_historiques'));
  expect(historiques).toHaveLength(2); // créations + validations
  for (const sql of historiques) {
    expect(sql).not.toMatch(/"ReserveHistorique"\."chantier/);
    expect(sql).toContain('"reserve"."chantier_id"');
  }
});
