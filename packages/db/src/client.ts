import postgres, { type Sql } from 'postgres';

export interface CreateDbOptions {
  applicationName: string;
  max?: number;
}

export interface Db {
  sql: Sql;
  ping(): Promise<boolean>;
  end(): Promise<void>;
}

export function createDb(url: string, { applicationName, max = 10 }: CreateDbOptions): Db {
  const sql = postgres(url, {
    max,
    // Supabase's session pooler works with prepared statements; the
    // transaction pooler (port 6543) would need prepare: false.
    prepare: true,
    connection: { application_name: applicationName },
    onnotice: () => {},
  });
  return {
    sql,
    async ping() {
      const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
      return row?.ok === 1;
    },
    end: () => sql.end({ timeout: 5 }),
  };
}
