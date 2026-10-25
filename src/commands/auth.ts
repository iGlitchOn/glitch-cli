import {
  type CustomEndpointFormat,
  type GlitchSettings,
  formatAuthSummary,
  maskApiKey,
  saveSettings,
} from '../config/settings.js';

export type QuestionFn = (promptText: string) => Promise<string>;
export type OutputFn = (message: string) => void;

export async function runAuthFlow(
  currentSettings: GlitchSettings,
  ask: QuestionFn,
  out: OutputFn = console.log,
  customHomeDir?: string,
): Promise<GlitchSettings> {
  out('=== Configuración de Autenticación (/auth) ===');
  out(`Estado actual: ${formatAuthSummary(currentSettings)}`);
  out('Selecciona el método de conexión:');
  out('  1) Vertex AI (Application Default Credentials - Free Trial)');
  out(
    '  2) API personalizada (OpenAI-compatible /v1/chat/completions o /v1/responses)',
  );

  const choice = (await ask('Opción [1/2]: ')).trim();

  if (choice === '1') {
    const defaultProject =
      currentSettings.vertex?.project ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      '';
    const defaultLocation =
      currentSettings.vertex?.location ||
      process.env['GOOGLE_CLOUD_LOCATION'] ||
      'us-central1';

    const projectInput = (
      await ask(
        `Proyecto GCP (GOOGLE_CLOUD_PROJECT)${defaultProject ? ` [${defaultProject}]` : ''}: `,
      )
    ).trim();
    const project = projectInput || defaultProject;
    if (!project) {
      out(
        '✗ Error: El proyecto de Google Cloud es obligatorio para Vertex AI.',
      );
      return currentSettings;
    }

    const locationInput = (
      await ask(`Región GCP (GOOGLE_CLOUD_LOCATION) [${defaultLocation}]: `)
    ).trim();
    const location = locationInput || defaultLocation;

    const updated: GlitchSettings = {
      ...currentSettings,
      provider: 'vertex',
      vertex: { project, location },
    };

    process.env['GOOGLE_CLOUD_PROJECT'] = project;
    process.env['GOOGLE_CLOUD_LOCATION'] = location;

    saveSettings(updated, customHomeDir);
    out(
      `✓ Conectado a Vertex AI (proyecto: ${project}, región: ${location}) usando ADC.`,
    );
    return updated;
  }

  if (choice === '2') {
    const defaultUrl =
      currentSettings.custom?.baseUrl || 'https://api.openai.com';
    const urlInput = (await ask(`Base URL [${defaultUrl}]: `)).trim();
    const baseUrl = urlInput || defaultUrl;

    const currentMasked = currentSettings.custom?.apiKey
      ? ` [${maskApiKey(currentSettings.custom.apiKey)}]`
      : '';
    const keyInput = (await ask(`API Key${currentMasked}: `)).trim();
    const apiKey = keyInput || currentSettings.custom?.apiKey || '';
    if (!apiKey) {
      out('✗ Error: La API Key es obligatoria para la API personalizada.');
      return currentSettings;
    }

    out('Formato de endpoint:');
    out('  1) /v1/chat/completions');
    out('  2) /v1/responses');
    const formatChoice = (await ask('Formato [1/2, por defecto 1]: ')).trim();
    const format: CustomEndpointFormat =
      formatChoice === '2' ? 'responses' : 'chat_completions';

    const updated: GlitchSettings = {
      ...currentSettings,
      provider: 'custom',
      custom: {
        baseUrl,
        apiKey,
        format,
      },
    };

    saveSettings(updated, customHomeDir);
    out(
      `✓ API personalizada guardada (${baseUrl}, formato: ${format}, key: ${maskApiKey(apiKey)}).`,
    );
    return updated;
  }

  out('✗ Opción inválida. Usa 1 (Vertex AI) o 2 (API personalizada).');
  return currentSettings;
}
