'use strict';

/**
 * Tests — suppression par lots (`utils/supprimerParLots.js`).
 *
 * La base annule toute requête au-delà de son délai (`statement_timeout`) :
 * la purge RGPD supprimait des mois de journaux en UN ordre, qui dépassait ce
 * délai sur un arriéré — la purge échouait chaque semaine, et l'arriéré ne
 * diminuait jamais. Ces tests verrouillent le découpage et, surtout, qu'il
 * s'arrête toujours.
 */

const { Op } = require('sequelize');
const { supprimerParLots } = require('../utils/supprimerParLots.js');

/** Table simulée : `findAll` rend les `limit` premières lignes restantes, `destroy` les retire. */
function table(nombre) {
  let lignes = Array.from({ length: nombre }, (_, i) => ({ id: `l${i}` }));
  return {
    findAll: jest.fn(async ({ limit }) => lignes.slice(0, limit)),
    destroy: jest.fn(async ({ where }) => {
      const ids = new Set(where.id[Op.in]);
      const avant = lignes.length;
      lignes = lignes.filter((l) => !ids.has(l.id));
      return avant - lignes.length;
    }),
    restantes: () => lignes.length,
  };
}

it('supprime TOUT, par lots de la taille demandée', async () => {
  const Modele = table(25);

  const total = await supprimerParLots(Modele, { createdAt: 'avant' }, { taille: 10 });

  expect(total).toBe(25);
  expect(Modele.restantes()).toBe(0);
  expect(Modele.destroy).toHaveBeenCalledTimes(3); // 10 + 10 + 5
});

it('applique la condition à la sélection, et ne supprime que les lignes sélectionnées', async () => {
  const Modele = table(3);

  await supprimerParLots(Modele, { createdAt: 'avant' }, { taille: 10 });

  expect(Modele.findAll.mock.calls[0][0]).toMatchObject({ where: { createdAt: 'avant' }, attributes: ['id'], limit: 10 });
  expect(Modele.destroy.mock.calls[0][0].where.id[Op.in]).toEqual(['l0', 'l1', 'l2']);
});

it('rien à purger : aucune suppression', async () => {
  const Modele = table(0);

  expect(await supprimerParLots(Modele, {})).toBe(0);
  expect(Modele.destroy).not.toHaveBeenCalled();
});

it('s’arrête si un lot ne supprime rien — jamais de boucle sans fin', async () => {
  const Modele = {
    findAll: jest.fn(async () => [{ id: 'bloquee' }, { id: 'aussi' }]),
    destroy: jest.fn(async () => 0),
  };

  expect(await supprimerParLots(Modele, {}, { taille: 2 })).toBe(0);
  expect(Modele.destroy).toHaveBeenCalledTimes(1);
});
