'use strict';

/**
 * Push FCM — comportements qui doivent tenir même quand tout va mal.
 *
 * Le push est un canal SECONDAIRE : la notification in-app reste la source de
 * vérité. Ces tests verrouillent le fait qu'aucune défaillance de Firebase ne
 * peut remonter jusqu'à l'action métier qui a déclenché la notification.
 */

const mockSendEachForMulticast = jest.fn();
const mockGetMessaging = jest.fn();

jest.mock('../config/firebase.js', () => ({
  getMessaging: (...args) => mockGetMessaging(...args),
  getFirebaseApp: jest.fn(),
}));

const mockDeviceToken = {
  findAll: jest.fn(),
  destroy: jest.fn(),
};

jest.mock('../models/index.js', () => ({
  Notification: { create: jest.fn(), bulkCreate: jest.fn(), findOne: jest.fn(), findAndCountAll: jest.fn(), count: jest.fn(), update: jest.fn() },
  Utilisateur: { findAll: jest.fn() },
  DeviceToken: mockDeviceToken,
  Chantier: { findOne: jest.fn() },
  ChantierMembre: { findAll: jest.fn() },
}));

const NotificationService = require('../modules/notification/service/notification.service.js');

const charge = { type: 'reserve.affectee', titre: 'Nouvelle réserve', message: 'Fissure au R+2', donnees: { reserveId: 'r-1' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessaging.mockReturnValue({ sendEachForMulticast: mockSendEachForMulticast });
  mockSendEachForMulticast.mockResolvedValue({ responses: [] });
  mockDeviceToken.findAll.mockResolvedValue([]);
});

describe('sendPush — robustesse', () => {
  it('ne fait rien, sans lever, quand Firebase n’est pas configuré', async () => {
    mockGetMessaging.mockReturnValue(null);
    await expect(NotificationService.sendPush(['u-1'], charge)).resolves.toBeUndefined();
    expect(mockDeviceToken.findAll).not.toHaveBeenCalled();
  });

  it('n’appelle pas FCM quand l’utilisateur n’a aucun appareil', async () => {
    mockDeviceToken.findAll.mockResolvedValue([]);
    await NotificationService.sendPush(['u-1'], charge);
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });

  it('absorbe une panne de FCM sans la propager', async () => {
    mockDeviceToken.findAll.mockResolvedValue([{ token: 'jeton-valide-aaaaaaaaaaaa' }]);
    mockSendEachForMulticast.mockRejectedValue(new Error('FCM indisponible'));
    // Doit se résoudre : une réserve s'affecte même si Google est en panne.
    await expect(NotificationService.sendPush(['u-1'], charge)).resolves.toBeUndefined();
  });

  it('ignore les identifiants vides et dédoublonne les destinataires', async () => {
    mockDeviceToken.findAll.mockResolvedValue([{ token: 'jeton-valide-aaaaaaaaaaaa' }]);
    await NotificationService.sendPush(['u-1', 'u-1', null, undefined], charge);
    expect(mockDeviceToken.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { utilisateurId: ['u-1'] } })
    );
  });
});

describe('sendPush — contenu du message', () => {
  beforeEach(() => {
    mockDeviceToken.findAll.mockResolvedValue([{ token: 'jeton-valide-aaaaaaaaaaaa' }]);
  });

  it('porte un bloc `notification` — sans lui, rien ne s’affiche téléphone verrouillé', async () => {
    await NotificationService.sendPush(['u-1'], charge);
    const envoi = mockSendEachForMulticast.mock.calls[0][0];
    expect(envoi.notification).toEqual({ title: 'Nouvelle réserve', body: 'Fissure au R+2' });
  });

  it('sérialise `donnees` en chaîne — FCM refuse les objets dans `data`', async () => {
    await NotificationService.sendPush(['u-1'], charge);
    const envoi = mockSendEachForMulticast.mock.calls[0][0];
    Object.values(envoi.data).forEach((v) => expect(typeof v).toBe('string'));
    expect(JSON.parse(envoi.data.donnees)).toEqual({ reserveId: 'r-1' });
  });

  it('vise le canal Android déclaré côté mobile', async () => {
    await NotificationService.sendPush(['u-1'], charge);
    const envoi = mockSendEachForMulticast.mock.calls[0][0];
    // Doit rester aligné sur `push_service.dart` : un canal inconnu et
    // Android retombe sur un défaut sans son ni vibration.
    expect(envoi.android.notification.channelId).toBe('suivi_chantier_alertes');
    expect(envoi.android.notification.icon).toBe('ic_notification');
  });

  it('découpe en lots de 500 — plafond imposé par FCM', async () => {
    const jetons = Array.from({ length: 1200 }, (_, i) => ({ token: `jeton-${i}-aaaaaaaaaaaaaaaa` }));
    mockDeviceToken.findAll.mockResolvedValue(jetons);

    await NotificationService.sendPush(['u-1'], charge);

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(3);
    const tailles = mockSendEachForMulticast.mock.calls.map((c) => c[0].tokens.length);
    expect(tailles).toEqual([500, 500, 200]);
  });
});

describe('sendPush — ménage des jetons', () => {
  beforeEach(() => {
    mockDeviceToken.findAll.mockResolvedValue([
      { token: 'jeton-mort-aaaaaaaaaaaaaa' },
      { token: 'jeton-vivant-aaaaaaaaaaaa' },
      { token: 'jeton-quota-aaaaaaaaaaaaa' },
    ]);
  });

  it('supprime les jetons que FCM déclare morts', async () => {
    mockSendEachForMulticast.mockResolvedValue({
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: true },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });

    await NotificationService.sendPush(['u-1'], charge);

    expect(mockDeviceToken.destroy).toHaveBeenCalledWith({
      where: { token: ['jeton-mort-aaaaaaaaaaaaaa', 'jeton-quota-aaaaaaaaaaaaa'] },
    });
  });

  it('CONSERVE les jetons dont l’échec est temporaire', async () => {
    // Quota dépassé ou serveur indisponible : l'appareil existe toujours.
    // Le supprimer désabonnerait un utilisateur légitime pour un incident
    // passager.
    mockSendEachForMulticast.mockResolvedValue({
      responses: [
        { success: false, error: { code: 'messaging/server-unavailable' } },
        { success: false, error: { code: 'messaging/message-rate-exceeded' } },
        { success: true },
      ],
    });

    await NotificationService.sendPush(['u-1'], charge);

    expect(mockDeviceToken.destroy).not.toHaveBeenCalled();
  });
});

describe('supprimerDeviceToken', () => {
  it('filtre sur l’utilisateur ET le jeton', async () => {
    await NotificationService.supprimerDeviceToken('u-1', 'jeton-aaaaaaaaaaaaaaaaaa');
    // Sans le filtre sur l'utilisateur, un compte authentifié pourrait
    // désabonner l'appareil d'un autre en devinant son jeton.
    expect(mockDeviceToken.destroy).toHaveBeenCalledWith({
      where: { utilisateurId: 'u-1', token: 'jeton-aaaaaaaaaaaaaaaaaa' },
    });
  });

  it('ne touche à rien sans jeton', async () => {
    await NotificationService.supprimerDeviceToken('u-1', undefined);
    expect(mockDeviceToken.destroy).not.toHaveBeenCalled();
  });
});
