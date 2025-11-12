import torch.nn as nn


def build_model_from_json(arch_def):
    """Recursively build nn.Module from JSON list structure"""
    module_type, module_args = arch_def

    if module_type == "Sequential":
        return nn.Sequential(*[build_model_from_json(a) for a in module_args])
    elif module_type == "ResBlock":
        return ResBlock(
            **{key: build_model_from_json(arg) for key, arg in module_args.items()}
        )
    elif hasattr(nn, module_type):
        return getattr(nn, module_type)(**module_args)
    else:
        raise ValueError(f"Unknown layer type: {module_type}")


class ResBlock(nn.Module):
    def __init__(self, nested):
        super().__init__()
        self.nested = nested

    def forward(self, x):
        return x + self.nested(x)
