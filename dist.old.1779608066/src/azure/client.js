import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
export function createAcaClient(cfg) {
    const credential = cfg.useManagedIdentity
        ? new DefaultAzureCredential()
        : new ClientSecretCredential(cfg.tenantId, cfg.clientId, cfg.clientSecret);
    return new ContainerAppsAPIClient(credential, cfg.subscriptionId);
}
export async function createManualJob(client, input) {
    const secrets = [];
    const envVars = [];
    for (const [name, value] of Object.entries(input.env)) {
        const lower = name.toLowerCase();
        const isSecret = lower.includes("token") || lower.includes("key") || lower.includes("secret");
        if (isSecret) {
            const secretName = lower.replaceAll(/[^a-z0-9-]/g, "-");
            secrets.push({ name: secretName, value });
            envVars.push({ name, secretRef: secretName });
        }
        else {
            envVars.push({ name, value });
        }
    }
    const job = {
        location: input.location,
        properties: {
            environmentId: input.environmentId,
            configuration: {
                triggerType: "Manual",
                replicaTimeout: 7200,
                replicaRetryLimit: 0,
                secrets
            },
            template: {
                containers: [
                    {
                        name: "worker",
                        image: input.image,
                        env: envVars
                    }
                ]
            }
        }
    };
    await client.jobs.beginCreateOrUpdateAndWait(input.resourceGroup, input.jobName, job);
}
export async function startJob(client, resourceGroup, jobName) {
    await client.jobs.beginStartAndWait(resourceGroup, jobName);
}
//# sourceMappingURL=client.js.map