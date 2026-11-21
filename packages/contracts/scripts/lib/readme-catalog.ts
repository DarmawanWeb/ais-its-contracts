import {
  API_KEY_SCOPES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
} from '../../src/auth/index.js';
import {
  CONSUMER_LIST,
  consumersOfEvent,
  CORE_SUBSCRIPTIONS,
  EVENT_DEFINITIONS,
  ORDERED_CONSUMERS,
  SERVICE_NAMES,
  STREAM_LIST,
} from '../../src/events/index.js';
import { formatDuration } from './asyncapi.js';

const code = (value: string): string => `\`${value}\``;

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join(
    '\n',
  );
}

/** Table of every event type. */
export function renderEventsTable(): string {
  return table(
    ['Event type', 'Payload', 'Subject', 'Stream', 'Producers', 'Consumers'],
    EVENT_DEFINITIONS.map((definition) => [
      code(definition.type),
      code(definition.payloadName),
      code(definition.subject),
      code(definition.stream),
      SERVICE_NAMES.every((service) => definition.producers.includes(service))
        ? 'every service'
        : definition.producers.join(', '),
      consumersOfEvent(definition.type)
        .map((consumer) =>
          'durableName' in consumer
            ? code(consumer.durableName)
            : `${code(consumer.name)} (ordered)`,
        )
        .join(', '),
    ]),
  );
}

/** Table of every JetStream stream. */
export function renderStreamsTable(): string {
  return table(
    [
      'Stream',
      'Subjects',
      'Retention',
      'Max age',
      'Max msgs / subject',
      'Dedup window',
      'Description',
    ],
    STREAM_LIST.map((stream) => [
      code(stream.name),
      stream.subjects.map(code).join(', '),
      stream.retention,
      formatDuration(stream.maxAgeMs),
      stream.maxMsgsPerSubject < 0 ? '∞' : String(stream.maxMsgsPerSubject),
      formatDuration(stream.duplicateWindowMs),
      stream.description,
    ]),
  );
}

/** Table of every consumer and core subscription. */
export function renderConsumersTable(): string {
  return table(
    ['Consumer', 'Kind', 'Stream / subject', 'Filter', 'Service', 'Purpose'],
    [
      ...CONSUMER_LIST.map((consumer) => [
        code(consumer.durableName),
        `durable (max deliver ${consumer.maxDeliver})`,
        code(consumer.stream),
        consumer.filterSubjects.map(code).join(', '),
        consumer.service,
        consumer.description,
      ]),
      ...ORDERED_CONSUMERS.map((consumer) => [
        code(consumer.name),
        'ordered (ephemeral)',
        code(consumer.stream),
        consumer.filterSubjects.map(code).join(', '),
        consumer.service,
        consumer.description,
      ]),
      ...CORE_SUBSCRIPTIONS.map((subscription) => [
        code(subscription.name),
        'core NATS',
        '—',
        code(subscription.subject),
        subscription.service,
        subscription.description,
      ]),
    ],
  );
}

/** Role × permission matrix (spec 8.4) followed by the API key scopes. */
export function renderPermissionMatrix(): string {
  const matrix = table(
    ['Permission', ...ROLES.map(code)],
    PERMISSIONS.map((permission) => [
      code(permission),
      ...ROLES.map((role) =>
        ROLE_PERMISSIONS[role].includes(permission) ? '✓' : '',
      ),
    ]),
  );
  return `${matrix}\n\nAPI key scopes: ${API_KEY_SCOPES.map(code).join(', ')}.`;
}

/** Generated README sections keyed by marker name. */
export const README_SECTIONS: Readonly<Record<string, () => string>> = {
  events: renderEventsTable,
  streams: renderStreamsTable,
  consumers: renderConsumersTable,
  permissions: renderPermissionMatrix,
};

/**
 * Replaces the content between `<!-- generated:<name>:start -->` and
 * `<!-- generated:<name>:end -->`.
 *
 * @throws {Error} when the markers are missing.
 */
export function replaceGeneratedSection(
  markdown: string,
  name: string,
  content: string,
): string {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);
  if (from < 0 || to < from) {
    throw new Error(`README is missing the markers of section "${name}"`);
  }
  return `${markdown.slice(0, from + start.length)}\n\n${content}\n\n${markdown.slice(to)}`;
}
