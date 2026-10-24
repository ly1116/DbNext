import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type {
  DbColumn,
  DbColumnAlterSpec,
  DbColumnSpec,
  DbCreateOptions,
  DbCreateSpec,
  DbForeignKey,
  DbIndex,
  DbObjectDef,
  DbObjectMeta,
  DbSequenceInfo,
  DbTrigger,
  DbUser,
  DbUserPrivEdit,
  DbUserPrivilege,
  DbUserSpec,
  PagedSqlResult,
  QueryResult,
  RoutineExecRequest,
  RoutineExecResult,
  RoutineParam,
  RoutineDebugState,
  SchemaDiffResult,
  ScriptResult,
} from '@shared/types';
import { cancelActiveQuery, getOracle } from '../clients/manager';
import {
  runSql,
  runSqlPaged,
  runScript,
  listSchemaColumns,
  listDatabases,
  listTables,
  listColumns,
  tableData,
  createDatabase,
  listSchemas,
  listObjects,
  listObjectsMeta,
  listPgMeta,
  listDbCreateOptions,
  addColumn,
  dropColumn,
  alterColumn,
  dropObject,
  renameObject,
  listIndexes,
  listForeignKeys,
  listTriggers,
  getViewDefinition,
  getFunctionDefinition,
  getSequenceInfo,
  listUsers,
  getUserPrivileges,
  updateUserPrivileges,
  createUser,
  dropUser,
  type DbObjKind,
  type DbMetaKind,
  type PgMetaKind,
} from '../services/sql.service';
import { runDiff, type DiffSideOptions } from '../services/diff.service';
import {
  oraGetRoutineParams,
  oraExecRoutine,
  oraDebugStart,
  oraDebugStep,
  oraDebugStop,
} from '../services/oracle.service';
import { listScripts, saveScript, deleteScript, renameScript, revealScript, openScriptsDir } from '../services/script.service';

/** 该连接是否为已建立的 Oracle 连接（存储过程执行/调试目前只支持 Oracle） */
function isOracleConn(connectionId: string): boolean {
  return !!getOracle(connectionId);
}

/** SQL 查询 / 脚本 / 对象内省 / 存储过程例程 / 结构对比 IPC 通道。 */
export function registerSqlIpc(): void {
  // —— SQL ——
  handle(IPC.SQL_RUN, (_e, connectionId: string, sql: string, db?: string): Promise<QueryResult> => runSql(connectionId, sql, db));
  handle(IPC.SQL_RUN_PAGED, (_e, connectionId: string, sql: string, offset: number, limit: number, db?: string): Promise<PagedSqlResult> => runSqlPaged(connectionId, sql, offset, limit, db));
  handle(IPC.SQL_SCRIPT, (_e, connectionId: string, script: string, db?: string): Promise<ScriptResult> => runScript(connectionId, script, db));
  handle(IPC.SQL_SCHEMA_COLUMNS, (_e, connectionId: string, db?: string): Promise<Record<string, string[]>> => listSchemaColumns(connectionId, db));
  handle(IPC.SQL_DATABASES, (_e, connectionId: string): Promise<string[]> => listDatabases(connectionId));
  handle(IPC.SQL_CREATE_DB, (_e, connectionId: string, spec: DbCreateSpec): Promise<void> => createDatabase(connectionId, spec));
  handle(IPC.SQL_DB_CREATE_OPTIONS, (_e, connectionId: string): Promise<DbCreateOptions> => listDbCreateOptions(connectionId));
  handle(IPC.SQL_TABLES, (_e, connectionId: string, database?: string, pgDb?: string): Promise<string[]> => listTables(connectionId, database, pgDb));
  handle(IPC.SQL_COLUMNS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]> => listColumns(connectionId, schema, table, db));
  handle(IPC.SQL_TABLE_DATA, (_e, connectionId: string, schema: string | undefined, table: string, limit?: number, db?: string, offset?: number, filter?: { where?: string; orderBy?: string }): Promise<QueryResult> => tableData(connectionId, schema, table, limit, db, offset, filter));
  handle(IPC.SQL_SCHEMAS, (_e, connectionId: string, db?: string): Promise<string[]> => listSchemas(connectionId, db));
  handle(IPC.SQL_OBJECTS, (_e, connectionId: string, kind: DbObjKind, schema: string, db?: string): Promise<string[]> => listObjects(connectionId, kind, schema, db));
  handle(IPC.SQL_PG_META, (_e, connectionId: string, kind: PgMetaKind, db?: string): Promise<string[]> => listPgMeta(connectionId, db, kind));
  handle(IPC.SQL_OBJECTS_META, (_e, connectionId: string, kind: DbMetaKind, schema: string, db?: string): Promise<DbObjectMeta[]> => listObjectsMeta(connectionId, kind, schema, db));
  handle(IPC.SQL_DROP_OBJECT, (_e, connectionId: string, kind: DbObjKind, schema: string, name: string, db?: string): Promise<void> => dropObject(connectionId, kind, schema, name, db));
  handle(IPC.SQL_RENAME_OBJECT, (_e, connectionId: string, kind: 'table' | 'view' | 'mview' | 'sequence', schema: string, name: string, newName: string, db?: string): Promise<void> => renameObject(connectionId, kind, schema, name, newName, db));
  handle(IPC.SQL_ADD_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec, db?: string): Promise<void> => addColumn(connectionId, schema, table, col, db));
  handle(IPC.SQL_DROP_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, column: string, db?: string): Promise<void> => dropColumn(connectionId, schema, table, column, db));
  handle(IPC.SQL_ALTER_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, column: string, spec: DbColumnAlterSpec, db?: string): Promise<void> => alterColumn(connectionId, schema, table, column, spec, db));
  handle(IPC.SQL_INDEXES, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbIndex[]> => listIndexes(connectionId, schema, table, db));
  handle(IPC.SQL_FOREIGN_KEYS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbForeignKey[]> => listForeignKeys(connectionId, schema, table, db));
  handle(IPC.SQL_TRIGGERS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbTrigger[]> => listTriggers(connectionId, schema, table, db));
  handle(IPC.SQL_VIEW_DEF, (_e, connectionId: string, kind: 'view' | 'mview', schema: string, name: string, db?: string): Promise<DbObjectDef> => getViewDefinition(connectionId, kind, schema, name, db));
  handle(IPC.SQL_FUNCTION_DEF, (_e, connectionId: string, schema: string, name: string, db?: string): Promise<DbObjectDef> => getFunctionDefinition(connectionId, schema, name, db));
  // —— 存储过程 / 函数：参数元数据 · 执行 · DBMS_DEBUG 调试（仅 Oracle 走 PL/SQL 语义）——
  handle(IPC.SQL_ROUTINE_PARAMS, (_e, connectionId: string, schema: string, name: string, _db?: string): Promise<RoutineParam[]> =>
    isOracleConn(connectionId) ? oraGetRoutineParams(connectionId, schema, name) : Promise.resolve([]));
  handle(IPC.SQL_ROUTINE_EXEC, (_e, req: RoutineExecRequest): Promise<RoutineExecResult> => {
    if (!isOracleConn(req.connectionId)) return Promise.reject(new Error('当前仅支持 Oracle 存储过程/函数的参数化执行'));
    return oraExecRoutine(req.connectionId, req.schema, req.name, req.args, req.autoCommit ?? true);
  });
  handle(IPC.SQL_DEBUG_START, (_e, connectionId: string, schema: string, name: string, args: Record<string, string>) => {
    if (!isOracleConn(connectionId)) return Promise.reject(new Error('当前仅支持 Oracle 存储过程调试（DBMS_DEBUG）'));
    return oraDebugStart(connectionId, schema, name, args);
  });
  handle(IPC.SQL_DEBUG_STEP, (_e, debugId: string, action: 'step' | 'continue'): Promise<RoutineDebugState> => oraDebugStep(debugId, action));
  handle(IPC.SQL_DEBUG_STOP, (_e, debugId: string): Promise<void> => oraDebugStop(debugId));
  handle(IPC.SQL_SEQUENCE_INFO, (_e, connectionId: string, schema: string, name: string, db?: string): Promise<DbSequenceInfo> => getSequenceInfo(connectionId, schema, name, db));
  // —— 用户与权限管理（PG 角色 / MySQL 用户 / Oracle 用户）——
  handle(IPC.SQL_USERS, (_e, connectionId: string): Promise<DbUser[]> => listUsers(connectionId));
  handle(IPC.SQL_USER_PRIVS, (_e, connectionId: string, name: string, host?: string): Promise<DbUserPrivilege[]> => getUserPrivileges(connectionId, name, host));
  handle(IPC.SQL_USER_PRIVS_UPDATE, (_e, connectionId: string, name: string, host: string | undefined, edit: DbUserPrivEdit): Promise<void> => updateUserPrivileges(connectionId, name, host, edit));
  handle(IPC.SQL_USER_CREATE, (_e, connectionId: string, spec: DbUserSpec): Promise<void> => createUser(connectionId, spec));
  handle(IPC.SQL_USER_DROP, (_e, connectionId: string, name: string, host?: string): Promise<void> => dropUser(connectionId, name, host));

  // —— 取消查询（超时 / 手动停止；best-effort，底层驱动级取消）——
  handle(IPC.SQL_CANCEL, (_e, connectionId: string, db?: string) => cancelActiveQuery(connectionId, db));

  // —— SQL 脚本（落盘 .sql 文件）——
  handle(IPC.SCRIPT_LIST, (_e, connId: string) => listScripts(connId));
  handle(IPC.SCRIPT_SAVE, (_e, connId: string, name: string, sql: string) => saveScript(connId, name, sql));
  handle(IPC.SCRIPT_DELETE, (_e, connId: string, name: string) => deleteScript(connId, name));
  handle(IPC.SCRIPT_RENAME, (_e, connId: string, oldName: string, newName: string) => renameScript(connId, oldName, newName));
  handle(IPC.SCRIPT_REVEAL, (_e, connId: string, name: string) => revealScript(connId, name));
  handle(IPC.SCRIPT_OPEN_FOLDER, (_e, connId?: string): Promise<void> => openScriptsDir(connId));

  // —— 结构对比 ——
  handle(IPC.DIFF_RUN, (_e, leftId: string, rightId: string, leftOpts?: DiffSideOptions, rightOpts?: DiffSideOptions): Promise<SchemaDiffResult> => runDiff(leftId, rightId, leftOpts, rightOpts));
}
