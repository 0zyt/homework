#!/usr/bin/env node

import { defineService, runServiceMain } from "@chaitin-ai/octobus-sdk";
import * as handlers from "../src/handlers.js";

const service = defineService({
  handlers: {
    "businessidentification.v1.BusinessIdentificationService/ResetDemo": handlers.resetDemo,
    "businessidentification.v1.BusinessIdentificationService/DiscoverCandidates": handlers.discoverCandidatesHandler,
    "businessidentification.v1.BusinessIdentificationService/ListCandidates": handlers.listCandidates,
    "businessidentification.v1.BusinessIdentificationService/GetCandidateContext": handlers.getCandidateContext,
    "businessidentification.v1.BusinessIdentificationService/SaveCandidateAnalysis": handlers.saveCandidateAnalysis,
    "businessidentification.v1.BusinessIdentificationService/RunReplay": handlers.runReplay,
    "businessidentification.v1.BusinessIdentificationService/PublishPattern": handlers.publishPattern,
    "businessidentification.v1.BusinessIdentificationService/MatchIncomingAlerts": handlers.matchIncomingAlerts,
  },
});

runServiceMain(service);
