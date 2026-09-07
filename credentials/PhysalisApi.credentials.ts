import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from "n8n-workflow";

/**
 * PhysalisApi — credentials pour le nœud Physalis.
 *
 * Stocke 2 valeurs :
 *   - Vault URL : URL de l'instance Physalis (ex: https://vault.physalis.cloud)
 *   - Bearer Token : token sv_user_<hex>, sv_org_<hex> ou sv_<hex> (machine)
 *
 * Le test de connexion ping `GET /api/integrations/projects` qui doit
 * retourner 200 avec un JSON `{ projects: [...] }`. Validé même si la liste
 * est vide (token sans projet → toujours valide, juste vide).
 *
 * Les labels et descriptions visibles dans l'UI N8n sont en anglais (convention
 * n8n community node — eslint-plugin-n8n-nodes-base est strict sur ce point).
 */
export class PhysalisApi implements ICredentialType {
  name = "physalisApi";

  displayName = "Physalis API";

  /**
   * ⚠️ Exigée par la vérification n8n (`cred-class-field-icon-missing`), et
   * pas seulement pour la forme : sans elle, l'écran de credentials affiche un
   * carré vide là où l'utilisateur cherche « Physalis ».
   *
   * Le chemin est relatif au fichier compilé, donc au dossier du nœud — c'est
   * la même image que celle du nœud, et non une copie qui divergerait.
   */
  icon: Icon = "file:../nodes/Physalis/physalis.svg";

  // eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
  documentationUrl =
    "https://physalis.cloud/en/docs";

  properties: INodeProperties[] = [
    {
      displayName: "Vault URL",
      name: "vaultUrl",
      type: "string",
      default: "https://vault.physalis.cloud",
      placeholder: "https://vault.physalis.cloud",
      description:
        "URL of your Physalis instance (without trailing slash). For self-hosted, use the URL of your deployment.",
      required: true,
    },
    {
      displayName: "Bearer Token",
      name: "bearerToken",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "Token generated in Physalis. Three variants accepted: sv_user_* (personal, Settings → Security), sv_org_* (organization, Org → Tokens, recommended for long-lived workflows), or sv_* (machine, scoped to project+env).",
      required: true,
    },
  ];

  // Injecte le header Authorization Bearer sur toutes les requêtes du nœud
  // qui utilisent ces credentials.
  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.bearerToken}}",
      },
    },
  };

  // Test de connexion affiché dans l'UI credentials de N8n (bouton « Test »).
  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.vaultUrl}}",
      url: "/api/integrations/projects",
      method: "GET",
    },
  };
}
