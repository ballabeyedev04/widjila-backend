'use strict';

/**
 * Tests — le journal ne perd plus le motif d'une erreur, et ne garde aucun secret.
 *
 * Défaut reproduit : `logger.error('[job] erreur rappels échéances :', err.message)`
 * — le second argument partait dans `info[SPLAT]`, que winston n'affiche pas
 * sans format `splat()`. La ligne se terminait par « : ». Une dizaine d'appels
 * (jobs nocturnes, push, notifications, audit) écrivaient ainsi des erreurs
 * sans motif.
 *
 * Masquage : mots de passe, jetons, en-tête Authorization — au premier niveau,
 * dans un objet imbriqué, et dans le texte même du message.
 */

const Transport = require('winston-transport');
const logger = require('../utils/logger.js');
const { executerDansContexte } = require('../utils/requestContext.js');

function capturerJournal() {
  const lignes = [];
  const transport = new (class extends Transport {
    log(info, rappel) {
      lignes.push(info);
      rappel();
    }
  })();
  logger.add(transport);
  return { lignes, arreter: () => logger.remove(transport) };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1Njc4OTAifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

let journal;
beforeEach(() => { journal = capturerJournal(); });
afterEach(() => journal.arreter());

describe('motif des erreurs', () => {
  it('un argument texte après le message n’est plus perdu', () => {
    logger.error('[job] erreur rappels échéances :', 'connexion refusée par PostgreSQL');

    expect(journal.lignes[0].message).toBe('[job] erreur rappels échéances : connexion refusée par PostgreSQL');
  });

  it('un objet de contexte reste fusionné comme avant', () => {
    logger.warn('[push] Envoi impossible', { error: 'quota dépassé', code: 'messaging/quota-exceeded' });

    expect(journal.lignes[0]).toMatchObject({ message: '[push] Envoi impossible', error: 'quota dépassé' });
  });
});

describe('masquage des secrets', () => {
  it('masque les clés sensibles, au premier niveau et dans un objet imbriqué', () => {
    const meta = {
      password: 'Secret123!',
      refresh_token: 'abc',
      headers: { Authorization: `Bearer ${JWT}`, 'content-type': 'application/json' },
      corps: { motDePasse: 'x', email: 'a@b.fr' },
    };

    logger.info('requête reçue', meta);

    const ligne = journal.lignes[0];
    expect(ligne.password).toBe('[masqué]');
    expect(ligne.refresh_token).toBe('[masqué]');
    expect(ligne.headers.Authorization).toBe('[masqué]');
    expect(ligne.headers['content-type']).toBe('application/json');
    expect(ligne.corps.motDePasse).toBe('[masqué]');
    // L'objet du code appelant n'est jamais modifié.
    expect(meta.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(meta.corps.motDePasse).toBe('x');
  });

  it('masque un Bearer et un JWT écrits dans le texte du message', () => {
    logger.warn(`appel refusé avec Authorization: Bearer ${JWT}`);
    logger.warn(`jeton reçu ${JWT} en paramètre`);

    expect(journal.lignes[0].message).toBe('appel refusé avec Authorization: Bearer [masqué]');
    expect(journal.lignes[1].message).toBe('jeton reçu [masqué] en paramètre');
  });

  it.each([
    ['refresh_token', true], ['Refresh-Token', true], ['refreshToken', true], ['motDePasse', true],
    ['authorization', true], ['hmac_compute', true], ['code', false], ['message', false], ['email', false],
  ])('clé « %s » sensible : %s', (cle, attendu) => {
    expect(logger.estCleSensible(cle)).toBe(attendu);
  });
});

describe('corrélation', () => {
  it('ajoute requestId et utilisateurId du contexte courant', () => {
    executerDansContexte({ requestId: 'ctx-12345678', utilisateurId: 'u-42' }, () => {
      logger.info('dans le contexte');
    });

    expect(journal.lignes[0]).toMatchObject({ requestId: 'ctx-12345678', utilisateurId: 'u-42' });
  });

  it('n’écrase pas un requestId fourni explicitement', () => {
    executerDansContexte({ requestId: 'ctx-12345678' }, () => {
      logger.info('explicite', { requestId: 'job-xyz-000001' });
    });

    expect(journal.lignes[0].requestId).toBe('job-xyz-000001');
  });

  it('hors requête, aucune clé de corrélation n’est inventée', () => {
    logger.info('au démarrage');

    expect(journal.lignes[0].requestId).toBeUndefined();
  });
});
