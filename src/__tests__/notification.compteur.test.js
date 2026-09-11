'use strict';

/**
 * Tests — `GET /notifications/non-lues/count` (compteur de la cloche).
 *
 * Le compteur est lu à CHAQUE écran par le mobile et le web. Il lisait la
 * liste des notifications pour n'en garder que le nombre ; il passe désormais
 * par une seule requête COUNT. Le contrat de réponse, lui, ne doit pas bouger :
 * les deux clients lisent `data.nonLuesCount`.
 */

jest.mock('../modules/notification/service/notification.service.js', () => ({
  compterNonLues: jest.fn(),
  listNotifications: jest.fn(),
}));

const NotificationService = require('../modules/notification/service/notification.service.js');
const controleur = require('../modules/notification/controller/notification.controller.js');

function reponse() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('compteur de notifications non lues', () => {
  it('une seule requête COUNT — la liste n’est plus chargée pour être comptée', async () => {
    NotificationService.compterNonLues.mockResolvedValue(7);
    const res = reponse();
    const next = jest.fn();

    await controleur.compterNonLues({ user: { id: 'u1' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(NotificationService.compterNonLues).toHaveBeenCalledWith('u1');
    expect(NotificationService.listNotifications).not.toHaveBeenCalled();
  });

  it('contrat INCHANGÉ pour les clients : `data.nonLuesCount`', async () => {
    NotificationService.compterNonLues.mockResolvedValue(3);
    const res = reponse();

    await controleur.compterNonLues({ user: { id: 'u1' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { nonLuesCount: 3 } });
  });

  it('une panne remonte au gestionnaire d’erreurs, sans réponse partielle', async () => {
    NotificationService.compterNonLues.mockRejectedValue(new Error('base indisponible'));
    const res = reponse();
    const next = jest.fn();

    await controleur.compterNonLues({ user: { id: 'u1' } }, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });
});
