import type { PushItemInput, PushListResult } from "../../types";
import { requireUserToken } from "./auth";
import { ahGraphql, ahRequest } from "./client";

const ADD_MUTATION = `mutation AddItems($items: [BasketItemInput!]!) {
  basketItemsAdd(input: { items: $items }) { status errorMessage }
}`;

const REST_PATH = "/mobile-services/shoppinglist/v2/items?orderBy=userInput&orderByParam=0";

function cleanItems(items: PushItemInput[]): PushItemInput[] {
  return items.filter((i) => Number.isFinite(Number(i.externalId)) && Number(i.externalId) > 0 && i.quantity > 0);
}

async function pushViaGraphql(token: string, items: PushItemInput[]): Promise<void> {
  const data = await ahGraphql<{ basketItemsAdd?: { status?: string | null; errorMessage?: string | null } | null }>(
    ADD_MUTATION,
    { items: items.map((i) => ({ productId: Number(i.externalId), quantity: Math.max(1, Math.round(i.quantity)) })) },
    token,
  );
  const result = data.basketItemsAdd;
  if (!result) throw new Error("basketItemsAdd gaf geen resultaat");
  // Some mutations omit `status` while still succeeding.
  if (result.status && result.status !== "SUCCESS") {
    throw new Error(result.errorMessage ?? `basketItemsAdd status ${result.status}`);
  }
}

async function pushViaRest(token: string, items: PushItemInput[]): Promise<void> {
  await ahRequest(REST_PATH, {
    method: "PATCH",
    token,
    body: {
      items: items.map((i) => ({
        productId: Number(i.externalId),
        quantity: Math.max(1, Math.round(i.quantity)),
        type: "SHOPPABLE",
        originCode: "PRD",
        description: i.title,
        strikeThrough: false,
      })),
    },
  });
}

export async function pushToAhList(items: PushItemInput[]): Promise<PushListResult> {
  const token = await requireUserToken();
  const valid = cleanItems(items);
  if (valid.length === 0) {
    return { provider: "ah", success: true, itemsPushed: 0, message: "Geen Albert Heijn-producten om door te sturen" };
  }
  try {
    await pushViaGraphql(token, valid);
  } catch (graphqlError) {
    try {
      await pushViaRest(token, valid);
    } catch (restError) {
      return {
        provider: "ah",
        success: false,
        itemsPushed: 0,
        message: `Doorsturen naar de AH-boodschappenlijst mislukt: ${(restError as Error).message} (GraphQL: ${(graphqlError as Error).message})`,
      };
    }
  }
  return {
    provider: "ah",
    success: true,
    itemsPushed: valid.length,
    message: `${valid.length} product(en) staan nu op je Albert Heijn-boodschappenlijst`,
  };
}
