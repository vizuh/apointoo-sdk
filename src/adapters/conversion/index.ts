// Public surface for the conversion adapter family (kit #14).
//
// Consumers import:
//   - Interface + input/result types + error class:
//       from '@vizuh/apointoo-sdk/adapters/conversion'
//   - A concrete impl (memory now, google-ads in Part B):
//       from '@vizuh/apointoo-sdk/adapters/conversion/memory'

export type {
  ConversionReporter,
  ConversionUploadInput,
  ConversionUploadResult,
  ConversionReporterErrorCode,
} from './reporter.js'

export {
  ConversionReporterError,
  isConversionReporterError,
  validateConversionInput,
} from './reporter.js'

export type {
  ConversionActionName,
  DefaultConversionActionName,
} from './action-names.js'

export {
  DEFAULT_CONVERSION_ACTION_ALLOWLIST,
  defineConversionAction,
} from './action-names.js'
