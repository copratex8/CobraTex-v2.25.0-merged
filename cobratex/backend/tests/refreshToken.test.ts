import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { login, refreshSession, logoutSession } from '@/modules/identity/identityService';
import { createFullTenantStack } from './helpers';

const app = createApp();

describe('Refresh Token — إصدار، تدوير، إبطال', () => {
  it('login يُصدر accessToken وrefreshToken معًا، ويُخزَّن هاش الأخير فقط في refresh_tokens', async () => {
    const f = await createFullTenantStack('rt-login');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);
    const real = await login(rows[0].email, 'Passw0rd!123', f.tenantId);
    expect(real.accessToken).toBeTruthy();
    expect(real.refreshToken).toBeTruthy();

    const stored = await pool.query(`SELECT token_hash, revoked_at, expires_at FROM refresh_tokens WHERE user_id = $1`, [f.userId]);
    expect(stored.rows.length).toBe(1);
    expect(stored.rows[0].revoked_at).toBeNull();
    expect(stored.rows[0].token_hash).not.toBe(real.refreshToken); // مخزَّن كهاش، لا كنص خام
    expect(new Date(stored.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshSession يُدوِّر التوكن: يُبطل القديم فورًا ويُصدر واحدًا جديدًا صالحًا', async () => {
    const f = await createFullTenantStack('rt-rotate');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);
    const first = await login(rows[0].email, 'Passw0rd!123', f.tenantId);

    const rotated = await refreshSession(first.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const rows2 = await pool.query(
      `SELECT revoked_at FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [f.userId],
    );
    expect(rows2.rows[0].revoked_at).not.toBeNull(); // التوكن الأول أُبطل بالتدوير

    // التوكن الجديد يعمل فعليًا لتدوير لاحق:
    const rotatedAgain = await refreshSession(rotated.refreshToken);
    expect(rotatedAgain.accessToken).toBeTruthy();
  });

  it('إعادة استخدام توكن مُدوَّر بالفعل (بعد تدويره) تُبطل كل جلسات المستخدم النشطة (كشف تسرُّب)', async () => {
    const f = await createFullTenantStack('rt-reuse');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);
    const first = await login(rows[0].email, 'Passw0rd!123', f.tenantId);
    const rotated = await refreshSession(first.refreshToken); // يُبطل first.refreshToken

    // محاولة إعادة استخدام التوكن الأول (المُبطَل بالفعل) — يجب أن تُرفض:
    await expect(refreshSession(first.refreshToken)).rejects.toThrow();

    // وأيضًا التوكن الثاني (rotated) الذي كان صالحًا لحظة قبل ذلك أصبح مُبطلًا الآن كإجراء احترازي:
    await expect(refreshSession(rotated.refreshToken)).rejects.toThrow();
  });

  it('refreshSession يرفض توكنًا عشوائيًا/مزوَّرًا', async () => {
    await expect(refreshSession('not-a-real-token')).rejects.toThrow();
  });

  it('logoutSession يُبطل التوكن فورًا، ومحاولة تجديده بعدها تُرفض؛ واستدعاؤه مرتين لا يُخرج خطأ', async () => {
    const f = await createFullTenantStack('rt-logout');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);
    const session = await login(rows[0].email, 'Passw0rd!123', f.tenantId);

    await logoutSession(session.refreshToken);
    await expect(refreshSession(session.refreshToken)).rejects.toThrow();
    await expect(logoutSession(session.refreshToken)).resolves.not.toThrow(); // idempotent
  });

  it('POST /auth/refresh وPOST /auth/logout عبر HTTP يعملان بنفس السلوك', async () => {
    const f = await createFullTenantStack('rt-http');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);
    const login1 = await login(rows[0].email, 'Passw0rd!123', f.tenantId);

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken: login1.refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeTruthy();
    expect(refreshRes.body.refreshToken).toBeTruthy();

    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken: refreshRes.body.refreshToken });
    expect(logoutRes.status).toBe(204);

    const secondRefresh = await request(app).post('/api/auth/refresh').send({ refreshToken: refreshRes.body.refreshToken });
    expect(secondRefresh.status).toBe(401);
  });

  it('POST /auth/refresh بلا refreshToken في الجسم يُرجع 422', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(422);
  });
});

describe('تحديد معدل تسجيل الدخول (Rate Limiting) — حماية من هجمات القوة الغاشمة', () => {
  it('بعد 10 محاولات فاشلة، المحاولة الحادية عشرة تُرفض بـ429 بصرف النظر عن صحة البيانات', async () => {
    const f = await createFullTenantStack('rt-ratelimit');
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [f.userId]);

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/auth/login').send({ email: rows[0].email, password: 'wrong-password', tenantId: f.tenantId });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post('/api/auth/login').send({ email: rows[0].email, password: 'Passw0rd!123', tenantId: f.tenantId });
    expect(blocked.status).toBe(429);
  });
});
