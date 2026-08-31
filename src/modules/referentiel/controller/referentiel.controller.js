'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { VUE_PUBLIQUE } = require('../../../config/enums.js');
const { VUE_PUBLIQUE: PAYS } = require('../../../config/pays.js');

/**
 * Énumérations métier servies aux clients.
 *
 * Le web et le mobile recopiaient ces listes à la main. Un statut ajouté au
 * backend restait alors invisible côté client : le filtre ne le proposait pas,
 * et le badge s'affichait sans libellé. Cet endpoint supprime la recopie.
 *
 * Ce qui est renvoyé, ce sont les CODES bruts stockés en base. Les libellés
 * restent traduits côté client, pour suivre la langue de l'utilisateur.
 *
 * Contenu strictement statique et non confidentiel : le cache HTTP long est
 * délibéré, ces listes ne changent qu'avec une migration et un déploiement.
 */
exports.getEnums = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    success: true,
    message: 'Référentiels récupérés',
    data: { enums: VUE_PUBLIQUE },
  });
});

/**
 * Pays proposés à l'inscription, et les identifiants d'entreprise de chacun.
 *
 * Le formulaire affichait SIRET, RCCM et NINEA à tout le monde : une
 * entreprise française se voyait demander un NINEA, une entreprise malienne
 * n'avait nulle part où saisir son NIF. Les clients lisent désormais cette
 * liste pour n'afficher que les champs qui ont un sens.
 *
 * PUBLIQUE et sans authentification : c'est un formulaire d'INSCRIPTION,
 * l'utilisateur n'a par définition pas encore de session.
 */
exports.getPays = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    success: true,
    message: 'Pays récupérés',
    data: { pays: PAYS },
  });
});
