export type PermissionScope = 'own_branch' | 'multi_branch' | 'all_branches';

export interface GrantedPermission {
  code: string;
  scope: PermissionScope;
}

export interface AuthenticatedUserClaims {
  userId: string;
  tenantId: string;
  companyId: string;
  /** فروع مسموح للمستخدم برؤيتها. فارغة تعني "كل الفروع" فقط إذا scopeType = 'all'. */
  branchIds: string[];
  scopeType: 'single' | 'multi' | 'all';
  /** الصلاحيات الممنوحة عبر أدوار المستخدم في هذه الشركة، بأعلى نطاق مُجمَّع لكل كود (راجع identityService.login). */
  permissions: GrantedPermission[];
}

/**
 * RequestContext يُشتق حصرًا من محتوى التوكن المُوقَّع (JWT)، وليس من جسم الطلب (body) أو
 * query params — هذا يمنع انتحال مؤسسة أو صلاحية عبر تعديل الطلب (راجع ARCHITECTURE.md §3.2).
 */
export class RequestContext {
  constructor(private readonly claims: AuthenticatedUserClaims) {}

  get userId() {
    return this.claims.userId;
  }
  get tenantId() {
    return this.claims.tenantId;
  }
  get companyId() {
    return this.claims.companyId;
  }

  /** يتحقق أن الفرع المطلوب ضمن نطاق رؤية المستخدم (بصرف النظر عن الصلاحية)، ويرمي خطأ صريح إن لم يكن كذلك. */
  assertBranchInScope(branchId: string): void {
    if (this.claims.scopeType === 'all') return;
    if (!this.claims.branchIds.includes(branchId)) {
      throw new ForbiddenScopeError(`المستخدم لا يملك صلاحية الوصول لهذا الفرع: ${branchId}`);
    }
  }

  /**
   * تحقق RBAC كامل: يتطلب امتلاك كود الصلاحية أولًا (403 إن لم يكن ممنوحًا)، ثم — إن مُرِّر فرع —
   * يتحقق من النطاق: منح بنطاق 'all_branches' يتجاوز فحص فرع المستخدم الشخصي؛ أي نطاق آخر يعود
   * لفحص "فروع هذا المستخدم" المعتاد (assertBranchInScope).
   */
  assertPermission(code: string, branchId?: string): GrantedPermission {
    const grant = this.claims.permissions.find((p) => p.code === code);
    if (!grant) {
      throw new ForbiddenScopeError(`ليس لدى المستخدم صلاحية: ${code}`);
    }
    if (branchId && grant.scope !== 'all_branches') {
      this.assertBranchInScope(branchId);
    }
    return grant;
  }

  /** نسخة من الصلاحيات الممنوحة (للتحقق من عدم تصعيد الصلاحيات عند منح أدوار). */
  get permissions(): GrantedPermission[] {
    return this.claims.permissions;
  }

  hasPermission(code: string): boolean {
    return this.claims.permissions.some((p) => p.code === code);
  }

  /** الفروع المسموح تصفية الاستعلام بها؛ null تعني "كل الفروع" (لا تصفية). */
  visibleBranchIds(): string[] | null {
    return this.claims.scopeType === 'all' ? null : this.claims.branchIds;
  }
}

export class ForbiddenScopeError extends Error {
  status = 403;
}
