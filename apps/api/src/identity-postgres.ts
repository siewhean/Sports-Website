import {
  PostgresAccountRepository,
  PostgresAuditRepository,
  PostgresJsQueryAdapter,
  type PostgresJsSql,
} from "@matchday/identity";
import type { IdentityPersistencePorts, IdentityPersistenceUnitOfWork } from "./identity-runtime.js";
import { PostgresAssuranceSessionRepository } from "./identity-assurance-session-repository.js";

export class PostgresIdentityUnitOfWork implements IdentityPersistenceUnitOfWork {
  constructor(private readonly sql: PostgresJsSql) {}

  async run<T>(operation: (ports: IdentityPersistencePorts) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Identity mutations require a transaction-capable PostgreSQL client.");
    return this.sql.begin(async (transaction) =>
      operation({
        accounts: new PostgresAccountRepository(transaction),
        sessions: new PostgresAssuranceSessionRepository(transaction),
        audit: new PostgresAuditRepository(new PostgresJsQueryAdapter(transaction)),
      }),
    );
  }
}
