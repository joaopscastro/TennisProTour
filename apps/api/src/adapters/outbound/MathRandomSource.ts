import { RandomSource } from '@tennis-manager/domain';

/** Production RandomSource: plain Math.random. Tests inject fixed
 * sequences instead — that's the whole point of the port. */
export class MathRandomSource implements RandomSource {
  next(): number {
    return Math.random();
  }
}
