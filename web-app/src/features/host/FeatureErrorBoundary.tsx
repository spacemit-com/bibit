import { Component, type ReactNode } from 'react'
import { FeatureErrorState } from '@bibit/feature-ui'
import i18n from '@/i18n/setup'

interface Props {
  children: ReactNode
  onRetry: () => void
}

interface State {
  failed: boolean
}

export class FeatureErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <FeatureErrorState
          title={i18n.t('common:featureLoadFailed')}
          onRetry={this.props.onRetry}
        />
      )
    }
    return this.props.children
  }
}
