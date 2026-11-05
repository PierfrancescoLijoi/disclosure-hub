import { PolicyRegistry } from '../domain/policy.js';
import { dkPolicy } from './dk.js';
import { ukPolicy } from './uk.js';
import { usPolicy } from './us.js';

/** Adding a jurisdiction = one policy file + one gateway adapter + one line here. */
export function defaultPolicies(): PolicyRegistry {
  return new PolicyRegistry().register(ukPolicy).register(usPolicy).register(dkPolicy);
}
