import { getEcas } from '@jetstream/api-config';
import { z } from 'zod';
import { createRoute, RouteValidator } from '../utils/route.utils';

export const routeDefinition = {
  listEcas: {
    controllerFn: () => listEcas,
    validators: {
      query: z.object({}),
      hasSourceOrg: false,
    } satisfies RouteValidator,
  },
};

const listEcas = createRoute(routeDefinition.listEcas.validators, async (_, _req, res) => {
  const ecas = getEcas().map(({ id, label, defaultFor }) => ({ id, label, defaultFor }));
  res.json({ ecas });
});
