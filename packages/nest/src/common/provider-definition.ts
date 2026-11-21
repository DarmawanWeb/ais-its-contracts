import type {
  ClassProvider,
  ExistingProvider,
  FactoryProvider,
  InjectionToken,
  Provider,
  ValueProvider,
} from '@nestjs/common';

/** A provider definition without its token (`useValue`, `useFactory`, `useClass` or `useExisting`). */
export type ProviderDefinition<T> =
  | Omit<ValueProvider<T>, 'provide'>
  | Omit<FactoryProvider<T>, 'provide'>
  | Omit<ClassProvider<T>, 'provide'>
  | Omit<ExistingProvider<T>, 'provide'>;

/** Binds a {@link ProviderDefinition} to its injection token. */
export function provideAs<T>(
  token: InjectionToken,
  definition: ProviderDefinition<T>,
): Provider<T> {
  return { ...definition, provide: token } as Provider<T>;
}
