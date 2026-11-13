import { PoolClient } from 'pg';
import { pool } from '@/db/pool';

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'submit' | 'approve' | 'reject' | 'post' | 'reverse' | 'cancel' | 'send_back'
  | 'login' | 'login_failed';

export interface AuditLogInput {
  tenantId: string;
  companyId: string;
  userId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: AuditAction;
  beforeJson?: unknown;
  afterJson?: unknown;
  reason?: string;
}

/**
 * يُستدعى من داخل نفس معاملة قاعدة البيانات التي تنفّذ العملية، بحيث يُسجَّل التدقيق دائمًا
 * إذا (وفقط إذا) نجحت العملية فعليًا (كلاهما يُلغى معًا عند ROLLBACK).
 * الجدول نفسه append-only على مستوى قاعدة البيانات (راجع migration 0002).
 */
export async function writeAuditLog(client: PoolClient | typeof pool, input: AuditLogInput) {
  await client.query(
    `INSERT INTO audit_logs(tenant_id, company_id, user_id, entity_type, entity_id, action, before_json, after_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.tenantId,
      input.companyId,
      input.userId ?? null,
      input.entityType,
      input.entityId ?? null,
      input.action,
      input.beforeJson ? JSON.stringify({ ...(input.beforeJson as object), reason: input.reason }) : (input.reason ? JSON.stringify({ reason: input.reason }) : null),
      input.afterJson ? JSON.stringify(input.afterJson) : null,
    ],
  );
}
