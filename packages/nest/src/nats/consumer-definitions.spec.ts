import {
  EVENT_TYPES,
  type TypedEventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type ConsumerEnvelope,
  type OrderedConsumerRef,
  resolveOrderedConsumer,
  UnknownConsumerError,
} from './consumer-definitions.js';

describe('ordered consumer references', () => {
  it('resolves contracts ORDERED_CONSUMERS keys and refuses unknown names', () => {
    expect(resolveOrderedConsumer('notification-safety')).toMatchObject({
      stream: 'SAFETY',
      eventTypes: [EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED],
    });
    expect(() =>
      resolveOrderedConsumer('notification-typo' as OrderedConsumerRef),
    ).toThrow(UnknownConsumerError);
  });

  it('types names (typos do not compile) and narrows the handler envelope', () => {
    expectTypeOf<'notification-positions'>().toExtend<OrderedConsumerRef>();
    expectTypeOf<'notification-typo'>().not.toExtend<OrderedConsumerRef>();
    expectTypeOf<ConsumerEnvelope<'notification-positions'>>().toEqualTypeOf<
      TypedEventEnvelope<typeof EVENT_TYPES.AIS_POSITION_RECORDED>
    >();
    expectTypeOf<ConsumerEnvelope<'emission-fuel'>>().toEqualTypeOf<
      TypedEventEnvelope<typeof EVENT_TYPES.FUEL_READING_RECORDED>
    >();
  });
});
