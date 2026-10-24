import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { ConnectionConfig, ConnectionSummary, OtpEntry, OtpPreview } from '@shared/types';
import {
  deleteConnection,
  exportProfile,
  importProfile,
  listConnections,
  saveConnection,
  listOtpEntryViews,
  saveOtpEntry,
  deleteOtpEntry,
  getOtpEntry,
} from '../services/connection-store';
import { totp } from '../services/totp';
import { connect, disconnect, testConnection, statusOf } from '../clients/manager';

/** 连接管理 + OTP 动态码因子库 IPC 通道。 */
export function registerConnectionIpc(): void {
  // —— 连接管理 ——
  handle(IPC.CONNECTION_LIST, (): ConnectionSummary[] => listConnections(statusOf));
  handle(IPC.CONNECTION_SAVE, (_e, cfg: ConnectionConfig): ConnectionSummary => saveConnection(cfg));
  handle(IPC.CONNECTION_DELETE, (_e, id: string) => deleteConnection(id));
  handle(IPC.CONNECTION_TEST, (_e, cfg: ConnectionConfig) => testConnection(cfg));
  handle(IPC.CONNECTION_CONNECT, (_e, id: string): Promise<ConnectionSummary> => connect(id));
  handle(IPC.CONNECTION_DISCONNECT, (_e, id: string) => disconnect(id));
  handle(IPC.CONNECTION_EXPORT, (_e, ids?: string[]) => exportProfile(ids));
  handle(IPC.CONNECTION_IMPORT, (_e, profile: string): ConnectionSummary[] => importProfile(profile));

  // —— OTP 动态码条目（TOTP 因子库；secret 只在主进程，列表为脱敏视图）——
  handle(IPC.OTP_LIST, () => listOtpEntryViews());
  handle(IPC.OTP_SAVE, (_e, entry: Partial<OtpEntry>) => saveOtpEntry(entry));
  handle(IPC.OTP_DELETE, (_e, id: string) => {
    deleteOtpEntry(id);
  });
  handle(
    IPC.OTP_PREVIEW,
    (_e, target: { entryId?: string; secret?: string; algorithm?: OtpEntry['algorithm']; digits?: number; period?: number }): OtpPreview => {
      const entry = target.entryId ? getOtpEntry(target.entryId) : undefined;
      const secret = target.secret?.trim() || entry?.secret;
      if (!secret) throw new Error('缺少 OTP 密钥（Base32）');
      return totp(secret, {
        algorithm: target.algorithm ?? entry?.algorithm,
        digits: target.digits ?? entry?.digits,
        period: target.period ?? entry?.period,
      });
    },
  );
}
