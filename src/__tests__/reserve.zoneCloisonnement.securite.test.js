'use strict';

/**
 * Tests — une réserve ne se rattache pas à la zone d'une autre organisation.
 *
 * `_verifierLocalisation` contrôlait la zone par un include
 * `Zone → Etage → Batiment (where chantierId)` dont l'étage n'était pas
 * `required` : jointure EXTERNE, toute zone de la plateforme passait. La
 * réserve affichait ensuite le nom de la zone étrangère, et la comptait
 * parmi les réserves liées — bloquant la suppression de la zone chez sa
 * véritable propriétaire. Même défaut au préchargement de l'import Excel.
 *
 * `findOne` émule la sémantique SQL de l'include (voir
 * annotation.cloisonnement.securite.test.js pour le principe).
 */

const modele = () => ({
  findOne: jest.fn(), findAll: jest.fn(), findByPk: jest.fn(), count: jest.fn(),
  create: jest.fn(), update: jest.fn(), destroy: jest.fn(),
});

// Tout modèle demandé par le service existe, doublé — seuls Zone et les
// modèles de localisation servent réellement ici.
jest.mock('../models/index.js', () => new Proxy({}, {
  get(cible, nom) {
    if (typeof nom !== 'string' || nom === '__esModule' || nom === 'then') return undefined;
    if (!(nom in cible)) cible[nom] = modele();
    return cible[nom];
  },
}));

const fs = require('fs');
const path = require('path');
const { Zone } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

/** Interne jusqu'au bâtiment filtré → rien ; externe → la zone revient. */
function emulerJointure(zone) {
  return async (options) => {
    const etage = options.include[0];
    return etage.required === true ? null : zone;
  };
}

describe('zone d’une autre organisation', () => {
  it('est refusée', async () => {
    Zone.findOne.mockImplementation(emulerJointure({ id: 'zone-B', nom: 'Hall A' }));

    const erreur = await ReserveService._verifierLocalisation('chantier-A', { zoneId: 'zone-B' });

    expect(erreur).toBe('Zone non rattachée à ce chantier');
  });

  it('une zone du chantier reste acceptée — non-régression', async () => {
    Zone.findOne.mockResolvedValue({ id: 'zone-A' });

    const erreur = await ReserveService._verifierLocalisation('chantier-A', { zoneId: 'zone-A' });

    expect(erreur).toBeFalsy();
  });
});

describe('import Excel', () => {
  it('le préchargement des zones exige la jointure jusqu’au chantier', () => {
    // Le préchargement vit au milieu d'une fonction d'import de fichier :
    // on vérifie la requête écrite plutôt que de fabriquer un classeur.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'reserve', 'service', 'reserveExcel.service.js'), 'utf8'
    );
    const ligne = source.split('\n').find((l) => /Zone\.findAll\(/.test(l));

    expect(ligne).toBeDefined();
    expect(ligne).toMatch(/model: Etage, as: 'etage', required: true/);
  });
});
