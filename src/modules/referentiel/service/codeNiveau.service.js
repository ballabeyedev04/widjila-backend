'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { CodeNiveau, Etage } = require('../../../models/index.js');
const { TYPE_NIVEAU } = require('../../../config/enums.js');

/**
 * Référentiel des CODES DE NIVEAU — « SS1 », « RDC », « R+1 », « TOIT »…
 *
 * ── RÈGLE DE VISIBILITÉ ───────────────────────────────────────────────────
 * Une organisation voit le catalogue STANDARD (`organisation_id IS NULL`) et
 * ses propres codes. Jamais ceux d'une autre organisation.
 *
 * ── RÈGLE D'ÉCRITURE ──────────────────────────────────────────────────────
 * Un code créé depuis le mobile appartient à l'organisation qui le crée. Le
 * catalogue standard n'appartient qu'au super-admin plateforme : sans cette
 * garde, une entreprise qui ajoute « SS7 » le pousserait à tous les clients
 * de la plateforme, y compris ses concurrents.
 *
 * ── POURQUOI PAS LE SERVICE GÉNÉRIQUE ─────────────────────────────────────
 * `ReferentielTypeService` couvre les référentiels à plat. Celui-ci porte un
 * `typeNiveau` qui commande tout : la liste proposée sous « SOUS-SOLS » ne
 * doit pas mélanger les codes de toiture, et c'est le seul filtre qui compte
 * à l'usage.
 */
class CodeNiveauService {
  /** Le standard + les codes de l'organisation. */
  static _visibilite(organisationId) {
    if (!organisationId) return { organisationId: null };
    return { [Op.or]: [{ organisationId: null }, { organisationId }] };
  }

  /**
   * Codes proposés à la saisie, par section.
   *
   * `typeNiveau` absent → tous, groupés côté client. C'est ce que fait l'écran
   * de dépôt, qui affiche les trois sections à la fois.
   *
   * Seuls les codes ACTIFS sont renvoyés : c'est une liste de saisie, un code
   * désactivé ne doit plus être proposé — les étages qui le portent déjà le
   * gardent.
   */
  static async lister(organisationId, { typeNiveau } = {}) {
    if (typeNiveau && !TYPE_NIVEAU.includes(typeNiveau)) {
      return { success: false, message: 'Type de niveau inconnu' };
    }

    const where = { ...CodeNiveauService._visibilite(organisationId), actif: true };
    if (typeNiveau) where.typeNiveau = typeNiveau;

    const codes = await CodeNiveau.findAll({
      where,
      // `ordre` d'abord : les niveaux se lisent du plus bas au plus haut, et
      // l'ordre alphabétique placerait « R+10 » entre « R+1 » et « R+2 ».
      order: [['typeNiveau', 'ASC'], ['ordre', 'ASC'], ['code', 'ASC']],
    });

    return { success: true, codes };
  }

  /**
   * Crée un code absent de la liste — le « + » de l'écran de dépôt.
   *
   * Le code appartient à l'ORGANISATION de l'appelant, jamais au catalogue
   * standard : le client a demandé que le prochain utilisateur voie le code
   * ajouté, et « le prochain utilisateur » désigne ses collègues, pas les
   * autres clients de la plateforme.
   */
  static async creer(organisationId, { typeNiveau, code, nom, ordre } = {}) {
    if (!organisationId) {
      // Le super-admin plateforme n'appartient à aucune organisation. Le
      // laisser créer ici écrirait dans le catalogue standard sans le dire —
      // c'est un geste d'administration, pas de saisie de chantier.
      return {
        success: false,
        message: 'Un code de niveau se crée depuis une organisation.',
      };
    }
    if (!TYPE_NIVEAU.includes(typeNiveau)) {
      return { success: false, message: 'Type de niveau inconnu' };
    }

    const codeNormalise = String(code || '').trim().toUpperCase();
    if (!codeNormalise) {
      return { success: false, message: 'Le code est obligatoire' };
    }

    // Le code existe-t-il déjà, standard ou propre ? On ne crée pas un
    // doublon : l'utilisateur qui tape « RDC » veut le RDC existant, et deux
    // « RDC » dans la liste ne se distingueraient pas à l'écran.
    const existant = await CodeNiveau.findOne({
      where: {
        ...CodeNiveauService._visibilite(organisationId),
        typeNiveau,
        code: codeNormalise,
      },
    });
    if (existant) {
      // Réactiver plutôt que refuser : un code désactivé puis ressaisi est
      // une demande de le remettre en service, pas une erreur.
      if (!existant.actif && existant.organisationId === organisationId) {
        await existant.update({ actif: true });
        return { success: true, message: 'Code de niveau rétabli', code: existant };
      }
      return { success: false, message: 'Ce code de niveau existe déjà' };
    }

    try {
      const cree = await CodeNiveau.create({
        organisationId,
        typeNiveau,
        code: codeNormalise,
        nom: (nom || '').trim() || null,
        // Sans rang fourni, le code se range EN FIN de sa section. On ne
        // devine pas une position : « SS7 » n'a pas de place évidente, et
        // l'insérer au milieu bousculerait une liste que l'utilisateur
        // connaît.
        ordre: Number.isInteger(ordre) ? ordre : 999,
      });
      return { success: true, message: 'Code de niveau créé', code: cree };
    } catch (e) {
      if (e instanceof UniqueConstraintError) {
        // Deux saisies simultanées du même code : l'index partiel a tranché.
        return { success: false, message: 'Ce code de niveau existe déjà' };
      }
      throw e;
    }
  }

  /**
   * Désactive un code de l'organisation.
   *
   * Jamais de suppression : les étages qui portent ce code garderaient une
   * référence morte, et le libellé disparaîtrait de leurs fiches.
   */
  static async desactiver(organisationId, id) {
    const code = await CodeNiveau.findByPk(id);
    if (!code) return { success: false, message: 'Code de niveau introuvable' };

    if (code.organisationId === null) {
      return {
        success: false,
        message: 'Le catalogue standard de la plateforme ne se modifie pas ici.',
      };
    }
    if (String(code.organisationId) !== String(organisationId)) {
      return { success: false, message: 'Ce code appartient à une autre organisation.' };
    }

    await code.update({ actif: false });

    // Information, pas blocage : le code reste porté par ces niveaux, il
    // cesse seulement d'être proposé.
    const usages = await Etage.count({ where: { codeNiveau: code.code } });
    return {
      success: true,
      message: usages > 0
        ? `Code désactivé — ${usages} niveau(x) le portent encore et le conservent.`
        : 'Code désactivé',
    };
  }
}

module.exports = CodeNiveauService;
