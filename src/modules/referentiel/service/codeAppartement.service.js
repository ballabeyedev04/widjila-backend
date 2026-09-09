'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { CodeAppartement } = require('../../../models/index.js');

/**
 * Référentiel des CODES D'APPARTEMENT — « A001 », « A002 », « B12 »…
 *
 * ── RÈGLE DE VISIBILITÉ ───────────────────────────────────────────────────
 * Une organisation voit le catalogue STANDARD (`organisation_id IS NULL`,
 * A001 → A015) et ses propres codes. Jamais ceux d'une autre organisation.
 *
 * ── RÈGLE D'ÉCRITURE ──────────────────────────────────────────────────────
 * Un code créé depuis le mobile appartient à l'organisation qui le crée. Le
 * catalogue standard n'appartient qu'au super-admin plateforme : sans cette
 * garde, une entreprise qui ajoute « B12 » le pousserait à tous les clients de
 * la plateforme, y compris ses concurrents.
 *
 * ── POURQUOI PAS `CodeNiveauService` ──────────────────────────────────────
 * Celui-là filtre et ordonne par `typeNiveau`, qui commande tout son usage. Un
 * appartement n'a pas de section : le partage de service imposerait un
 * `typeNiveau` fictif, que le premier filtre par section ferait remonter dans
 * la liste des niveaux.
 */
class CodeAppartementService {
  /** Le standard + les codes de l'organisation. */
  static _visibilite(organisationId) {
    if (!organisationId) return { organisationId: null };
    return { [Op.or]: [{ organisationId: null }, { organisationId }] };
  }

  /**
   * Codes proposés à la saisie.
   *
   * Seuls les codes ACTIFS sont renvoyés : c'est une liste de saisie, un code
   * désactivé ne doit plus être proposé — les appartements qui le portent déjà
   * le gardent.
   */
  static async lister(organisationId) {
    const codes = await CodeAppartement.findAll({
      where: { ...CodeAppartementService._visibilite(organisationId), actif: true },
      // `ordre` d'abord : le catalogue standard suit la numérotation naturelle,
      // et un ajout se range en fin de liste. `code` départage à rang égal.
      order: [['ordre', 'ASC'], ['code', 'ASC']],
    });

    return { success: true, codes };
  }

  /**
   * Crée un code absent de la liste — le « + » de la feuille de niveau.
   *
   * Le code appartient à l'ORGANISATION de l'appelant, jamais au catalogue
   * standard : le client a demandé que le prochain utilisateur voie le code
   * ajouté, et « le prochain utilisateur » désigne ses collègues, pas les
   * autres clients de la plateforme.
   */
  static async creer(organisationId, { code, nom, ordre } = {}) {
    if (!organisationId) {
      // Le super-admin plateforme n'appartient à aucune organisation. Le
      // laisser créer ici écrirait dans le catalogue standard sans le dire —
      // c'est un geste d'administration, pas de saisie de chantier.
      return {
        success: false,
        message: 'Un code d’appartement se crée depuis une organisation.',
      };
    }

    const codeNormalise = String(code || '').trim().toUpperCase();
    if (!codeNormalise) {
      return { success: false, message: 'Le code est obligatoire' };
    }

    // Le code existe-t-il déjà, standard ou propre ? On ne crée pas un
    // doublon : l'utilisateur qui tape « A001 » veut le A001 existant, et deux
    // « A001 » dans la liste ne se distingueraient pas à l'écran.
    const existant = await CodeAppartement.findOne({
      where: {
        ...CodeAppartementService._visibilite(organisationId),
        code: codeNormalise,
      },
    });
    if (existant) {
      // Réactiver plutôt que refuser : un code désactivé puis ressaisi est une
      // demande de le remettre en service, pas une erreur.
      if (!existant.actif && existant.organisationId === organisationId) {
        await existant.update({ actif: true });
        return { success: true, message: 'Code d’appartement rétabli', code: existant };
      }
      return { success: false, message: 'Ce code d’appartement existe déjà' };
    }

    try {
      const cree = await CodeAppartement.create({
        organisationId,
        code: codeNormalise,
        nom: (nom || '').trim() || null,
        // Sans rang fourni, le code se range EN FIN de liste. On ne devine pas
        // une position : « B12 » n'a pas de place évidente parmi des A0xx, et
        // l'insérer au milieu bousculerait une liste que l'utilisateur connaît.
        ordre: Number.isInteger(ordre) ? ordre : 999,
      });
      return { success: true, message: 'Code d’appartement créé', code: cree };
    } catch (e) {
      if (e instanceof UniqueConstraintError) {
        // Deux saisies simultanées du même code : l'index partiel a tranché.
        return { success: false, message: 'Ce code d’appartement existe déjà' };
      }
      throw e;
    }
  }

  /**
   * Désactive un code de l'organisation.
   *
   * Jamais de suppression : les appartements qui portent ce code garderaient
   * une référence morte, et le libellé disparaîtrait de leurs fiches.
   */
  static async desactiver(organisationId, id) {
    const code = await CodeAppartement.findByPk(id);
    if (!code) return { success: false, message: 'Code d’appartement introuvable' };

    if (code.organisationId === null) {
      return {
        success: false,
        message: 'Un code du catalogue standard ne se retire pas depuis un chantier.',
      };
    }
    if (code.organisationId !== organisationId) {
      return { success: false, message: 'Code d’appartement introuvable' };
    }

    await code.update({ actif: false });
    return { success: true, message: 'Code d’appartement retiré' };
  }
}

module.exports = CodeAppartementService;
