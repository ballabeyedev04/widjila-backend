'use strict';

const { Op } = require('sequelize');
const { AuditLog } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');

/**
 * Journal d'audit — écriture best-effort : ne doit jamais faire échouer
 * l'action principale. Conserve un snapshot du nom/email de l'admin pour
 * rester lisible même si le compte est supprimé ensuite.
 */
class AuditLogService {

  /**
   * @param {object} params
   * @param {object} params.admin — utilisateur admin ayant effectué l'action
   * @param {string} params.action — ex: 'utilisateur.role.change'
   * @param {string} [params.cibleType] — 'utilisateur' | 'organisation' | ...
   * @param {string} [params.cibleId]
   * @param {object} [params.details]
   * @param {string} [params.ip]
   */
  static async logAction({ admin, action, cibleType = null, cibleId = null, details = null, ip = null }) {
    try {
      await AuditLog.create({
        adminId: admin?.id || null,
        adminNom: admin ? `${admin.prenom} ${admin.nom}` : null,
        adminEmail: admin?.email || null,
        action,
        cibleType,
        cibleId: cibleId ? String(cibleId) : null,
        details,
        ip,
      });
    } catch (err) {
      logger.warn(`[audit] Échec journalisation "${action}" :`, err.message);
    }
  }

  /**
   * Liste paginée du journal, filtrable par admin / action / cible.
   */
  static async listLogs({ page = 1, limit = 20, adminId, action, cibleType, depuis } = {}) {
    const where = {};
    if (adminId) where.adminId = adminId;
    if (action) where.action = action;
    if (cibleType) where.cibleType = cibleType;
    if (depuis) where.createdAt = { [Op.gte]: new Date(depuis) };

    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { success: true, logs: rows, total: count };
  }
}

module.exports = AuditLogService;
