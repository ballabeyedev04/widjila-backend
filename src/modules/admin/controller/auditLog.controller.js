'use strict';

const AuditLogService = require('../service/auditLog.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');

exports.listerLogs = asyncHandler(async (req, res) => {
  const result = await AuditLogService.listLogs(req.query);
  res.status(200).json({
    success: true,
    message: 'Journal d’audit récupéré',
    data: { logs: result.logs, total: result.total },
  });
});
