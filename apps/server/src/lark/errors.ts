/** lark-cli 失败信封 → 结构化错误（判断分支靠 type/subtype，绝不正则 message） */
export class LarkCliError extends Error {
  readonly type: string;
  readonly subtype: string;
  readonly code: number | null;
  readonly hint: string | null;
  readonly missingScopes: string[];
  /** 应用级 scope 未申请时，开放平台一键申请页（信封 console_url） */
  readonly consoleUrl: string | null;
  readonly exitCode: number;

  constructor(args: {
    message: string;
    type?: string;
    subtype?: string;
    code?: number | null;
    hint?: string | null;
    missingScopes?: string[];
    consoleUrl?: string | null;
    exitCode: number;
  }) {
    super(args.message);
    this.name = 'LarkCliError';
    this.type = args.type ?? 'unknown';
    this.subtype = args.subtype ?? 'unknown';
    this.code = args.code ?? null;
    this.hint = args.hint ?? null;
    this.missingScopes = args.missingScopes ?? [];
    this.consoleUrl = args.consoleUrl ?? null;
    this.exitCode = args.exitCode;
  }

  get isMissingScope(): boolean {
    return this.subtype === 'missing_scope' || this.missingScopes.length > 0;
  }

  /** 给用户的补授权命令 */
  get fixCommand(): string | null {
    if (!this.missingScopes.length) return null;
    return `lark-cli auth login --scope "${this.missingScopes.join(' ')}"`;
  }
}
