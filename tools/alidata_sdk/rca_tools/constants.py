#!/usr/bin/env python

"""Global constants for tools configuration.

These constants specify the project, region, and workspace
parameters across all tools in the system.
"""

# Hardcoded configuration values
import os


PROJECT_NAME = "proj-xtrace-a4eeed5989b28f3ccb14ec6d5ee8cd2-cn-hongkong"
REGION_ID = "cn-hongkong"
WORKSPACE_NAME = "rca-benchmark"

ALIBABA_CLOUD_ACCESS_KEY_ID = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID')
ALIBABA_CLOUD_ACCESS_KEY_SECRET = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
