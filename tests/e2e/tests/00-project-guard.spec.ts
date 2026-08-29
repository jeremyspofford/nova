/**
 * Scenario 0 — the guard that decides which stack this suite may touch.
 *
 * Runs first, needs nothing: no browser, no stack, no docker socket. It is
 * here rather than in a separate unit suite because this is the one piece of
 * the walk whose failure mode is not a red test — it is stopping somebody
 * else's containers — and it should be impossible to run the walk without
 * having checked it.
 *
 * What it pins is the direction of failure. `decideProject()` is asked about
 * the states where something has already gone wrong (running inside a
 * container that cannot be identified, one with no compose label, an env var
 * contradicting the label) and every one of them has to REFUSE. The bug this
 * exists to prevent is a plausible one and was real: the old code answered
 * "am I in a container?" from the HOSTNAME format, so a `hostname:` line on
 * the service or a CI runner exporting HOSTNAME=runner made it decide it was
 * a host run, take the configured default, and scope restartProject() —
 * which restarts EVERY container in the project — at whatever that named.
 */
import { expect, test } from '@playwright/test'
import {
  CONTAINER_MARKER,
  decideProject,
  runningInContainer,
  selfContainerId,
  type ProjectFacts,
} from '../lib/docker'

const IN_A_CONTAINER: ProjectFacts = {
  inContainer: true,
  selfId: 'a'.repeat(64),
  label: 'nova-e2e',
  declared: undefined,
  hostFallback: 'nova-e2e',
}

test.describe('the project guard', () => {
  test('in a container, the compose label is the answer', () => {
    expect(decideProject(IN_A_CONTAINER)).toBe('nova-e2e')
    // …and it wins over a fallback that says otherwise, because the label is
    // a fact about this container and the fallback is a setting.
    expect(decideProject({ ...IN_A_CONTAINER, hostFallback: 'something-else' })).toBe('nova-e2e')
  })

  test('an unidentifiable container refuses instead of falling back', () => {
    // THE regression. Previously this returned hostFallback.
    expect(() => decideProject({ ...IN_A_CONTAINER, selfId: '' })).toThrow(
      /cannot establish which one/,
    )
    // Emphatically not the fallback, whatever the fallback happens to be.
    expect(() =>
      decideProject({ ...IN_A_CONTAINER, selfId: '', hostFallback: 'nova' }),
    ).toThrow(/cannot be guessed/)
  })

  test('a container with no compose label refuses', () => {
    expect(() => decideProject({ ...IN_A_CONTAINER, label: undefined })).toThrow(/no com\.docker\.compose\.project label/)
    expect(() => decideProject({ ...IN_A_CONTAINER, label: '' })).toThrow(/no com\.docker\.compose\.project label/)
  })

  test('an env var that contradicts the label refuses, naming both', () => {
    const boom = () => decideProject({ ...IN_A_CONTAINER, declared: 'nova' })
    expect(boom).toThrow(/NOVA_E2E_PROJECT=nova/)
    expect(boom).toThrow(/running inside compose project nova-e2e/)
  })

  test('an env var that agrees with the label is fine', () => {
    expect(decideProject({ ...IN_A_CONTAINER, declared: 'nova-e2e' })).toBe('nova-e2e')
  })

  test('on a host the configured value stands, and it is the throwaway project', () => {
    const onHost: ProjectFacts = {
      inContainer: false,
      selfId: '',
      label: undefined,
      declared: undefined,
      hostFallback: 'nova-e2e',
    }
    expect(decideProject(onHost)).toBe('nova-e2e')
    // A host run against another stack has to say so out loud; nothing
    // defaults there.
    expect(decideProject({ ...onHost, declared: 'some-other-stack' })).toBe('some-other-stack')
  })

  test('"am I in a container" is not answered by the hostname', () => {
    const noMarker = () => false
    const marker = (path: string) => path === CONTAINER_MARKER

    // A container whose hostname was overridden is still a container.
    expect(runningInContainer({ HOSTNAME: 'runner' }, marker)).toBe(true)
    // …and the compose overlay says so even where the marker file is absent.
    expect(runningInContainer({ HOSTNAME: 'runner', NOVA_E2E_IN_CONTAINER: '1' }, noMarker)).toBe(
      true,
    )
    // A host has neither, whatever its hostname looks like.
    expect(runningInContainer({ HOSTNAME: 'a'.repeat(64) }, noMarker)).toBe(false)
  })

  test('which container: hostname first, then mountinfo, then nothing', () => {
    const id = 'b'.repeat(64)
    const mountinfo = () => `571 covered / rw - overlay overlay rw,upperdir=/var/lib/docker/overlay2/${id}/diff\n`
    expect(selfContainerId({ HOSTNAME: 'c'.repeat(12) }, () => '')).toBe('c'.repeat(12))
    expect(selfContainerId({ HOSTNAME: 'runner' }, mountinfo)).toBe(id)
    // Nothing to go on is '' — which decideProject turns into a refusal, not
    // into a default.
    expect(selfContainerId({ HOSTNAME: 'runner' }, () => '')).toBe('')
  })
})
