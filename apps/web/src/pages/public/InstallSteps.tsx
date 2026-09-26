import type { DevicePlatform } from '../../lib/devicePlatform'
import { installSteps } from '../../lib/setupSteps'

/** One platform's add-to-home-screen steps, or every platform's when the device is not known. */
export function InstallSteps({ platform }: { platform: DevicePlatform }) {
  const lists = installSteps(platform)
  return (
    <div className="space-y-4">
      {lists.map(list => (
        <section key={list.label}>
          {lists.length > 1 && <h2 className="mb-1 text-compact font-medium text-content-primary">{list.label}</h2>}
          <ol className="list-decimal space-y-1 pl-5">
            {list.steps.map(step => (
              <li key={step.text}>{step.text}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
