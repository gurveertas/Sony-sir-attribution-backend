#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0ee86c45a1574c204800f00246c616eea709679d3a6daa07c128565fdc3af0e5/contract';
import startContract from '../../snapshots/0ee86c45a1574c204800f00246c616eea709679d3a6daa07c128565fdc3af0e5/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/426fa60d64f5cb1619e327441a94306f69c3683d9f7d675941fa1ff78de66002/contract';
import endContract from '../../snapshots/426fa60d64f5cb1619e327441a94306f69c3683d9f7d675941fa1ff78de66002/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Customer',
        column: col('emailEnc', 'bytea', { codecRef: { codecId: 'pg/bytea@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
