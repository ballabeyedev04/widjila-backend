'use strict';

/**
 * Tests — un identifiant malformé ne doit pas rendre 500.
 *
 * Cas réel : le mobile a demandé `GET /chantiers/envoi-plan` (une faute de
 * routage côté client). `findByPk('envoi-plan')` sur une clé UUID fait échouer
 * PostgreSQL, et l'erreur tombait dans la branche fourre-tout du gestionnaire.
 *
 * Trois raisons de ne pas laisser passer un 500 ici :
 *   - la supervision remonte une alerte pour une simple faute d'URL ;
 *   - le client affiche « erreur interne » là où « introuvable » est la
 *     vérité, et l'utilisateur croit le service en panne ;
 *   - hors production, le message contient la requête SQL.
 *
 * Ce qui NE doit pas changer : les autres `SequelizeDatabaseError` (colonne
 * absente, schéma périmé) restent des 500 — là, c'est bien le serveur qui est
 * en tort, et un 404 masquerait une panne réelle.
 */

const errorHandler = require('../middlewares/errorHandler.middleware.js');

/** Réponse Express réduite à ce que le gestionnaire utilise. */
function faireReponse() {
  const reponse = { code: null, corps: null };
  reponse.status = (code) => {
    reponse.code = code;
    return reponse;
  };
  reponse.json = (corps) => {
    reponse.corps = corps;
    return reponse;
  };
  return reponse;
}

/** Erreur telle que Sequelize la remonte pour un UUID invalide. */
function erreurUuid(valeur) {
  const err = new Error(
    `invalid input syntax for type uuid: "${valeur}"`
  );
  err.name = 'SequelizeDatabaseError';
  return err;
}

const requete = { method: 'GET', originalUrl: '/api/v1/chantiers/envoi-plan' };

describe('errorHandler — identifiant malformé', () => {
  it('répond 404 sur un UUID invalide', () => {
    const res = faireReponse();

    errorHandler(erreurUuid('envoi-plan'), requete, res, () => {});

    expect(res.code).toBe(404);
    expect(res.corps.success).toBe(false);
  });

  it('ne laisse pas fuir la requête SQL', () => {
    // Le message d'origine contient la valeur rejetée et, selon les cas, la
    // requête complète. La réponse doit être générique.
    const res = faireReponse();

    errorHandler(erreurUuid('envoi-plan'), requete, res, () => {});

    expect(res.corps.message).toBe('Ressource introuvable');
    expect(JSON.stringify(res.corps)).not.toMatch(/invalid input syntax/i);
  });

  it('laisse en 500 les autres erreurs de base', () => {
    // Non-régression : une colonne absente ou un schéma périmé est une panne
    // du serveur. La déguiser en 404 masquerait une migration oubliée —
    // exactement le genre de panne qu'on veut voir remonter.
    const err = new Error('column "motif_rejet" does not exist');
    err.name = 'SequelizeDatabaseError';
    const res = faireReponse();

    errorHandler(err, requete, res, () => {});

    expect(res.code).toBe(500);
  });

  it('ne touche pas aux erreurs de validation', () => {
    const err = new Error('validation');
    err.name = 'SequelizeValidationError';
    err.errors = [{ message: 'nom requis' }];
    const res = faireReponse();

    errorHandler(err, requete, res, () => {});

    expect(res.code).toBe(422);
  });
});
