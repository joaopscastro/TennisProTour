import { randomUUID } from 'node:crypto';
import { IdGeneratorPort } from '@tennis-manager/application';

export class CryptoIdGenerator implements IdGeneratorPort {
  generate(): string {
    return randomUUID();
  }
}
