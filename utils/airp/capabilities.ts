import type { AirpAutonomyLevel, AirpCapability } from './types';

export interface AirpCapabilityDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason:
    | 'allowed_read'
    | 'allowed_low_write'
    | 'confirmation_required'
    | 'wrong_environment'
    | 'autonomy_too_low'
    | 'forbidden';
}

const MIN_AUTONOMY: Record<'read' | 'low_write', AirpAutonomyLevel> = {
  read: 1,
  low_write: 2,
};

function reject(reason: AirpCapabilityDecision['reason']): AirpCapabilityDecision {
  return { allowed: false, requiresConfirmation: false, reason };
}

export function decideAirpCapability(
  capability: AirpCapability,
  autonomyLevel: AirpAutonomyLevel,
  environment: 'browser' | 'worker',
): AirpCapabilityDecision {
  if (capability.environment !== 'shared' && capability.environment !== environment) {
    return reject('wrong_environment');
  }

  switch (capability.risk) {
    case 'forbidden':
      return reject('forbidden');
    case 'confirm':
      return environment === 'browser'
        ? { allowed: true, requiresConfirmation: true, reason: 'confirmation_required' }
        : reject('forbidden');
    case 'read':
    case 'low_write':
      if (autonomyLevel < MIN_AUTONOMY[capability.risk]) return reject('autonomy_too_low');
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: capability.risk === 'read' ? 'allowed_read' : 'allowed_low_write',
      };
  }
}
